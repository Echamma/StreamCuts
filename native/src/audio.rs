//! Sound while playing. Each audible clip near the playhead gets an FFmpeg `SoundStream`; the output device's thread
//! mixes them by timeline sample, and the samples it has played are the playback clock, so the picture follows the sound.

use crate::ffmpeg::SoundStream;
use crate::project::Project;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Clips start decoding this far ahead of the playhead, so their sound is ready when it gets there.
const LOOKAHEAD: f64 = 2.0;
/// If the editor isn't drawn for this long (hidden behind another app, minimized), the sound stops with it.
const STALE: Duration = Duration::from_millis(400);
/// The longest playback waits for its first sound before starting without it.
const PREROLL: Duration = Duration::from_secs(2);

/// One clip's sound on the mix, in sample frames counted from where playback started.
struct Voice {
    /// The frame the front of `buffer` plays at, and the frame after the clip's last.
    next: u64,
    end: u64,
    volume: f32,
    /// Where the clip starts (before playback did, if negative) and its fades, in frames, for the fade envelope.
    clip_start: i64,
    fade_in: u64,
    fade_out: u64,
    chunks: Receiver<Vec<f32>>,
    buffer: VecDeque<f32>,
    /// Samples that came due before FFmpeg delivered them: dropped as they arrive, so the voice stays in time.
    owed: usize,
    /// FFmpeg finished (or failed): no more samples are coming.
    done: bool,
}

impl Voice {
    fn pull(&mut self, wanted: usize) {
        while self.buffer.len() < wanted {
            let chunk = match self.chunks.try_recv() {
                Ok(chunk) => chunk,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.done = true;
                    break;
                }
            };
            let skip = self.owed.min(chunk.len());
            self.owed -= skip;
            self.buffer.extend(&chunk[skip..]);
        }
    }

    fn skip(&mut self, samples: usize) {
        let buffered = samples.min(self.buffer.len());
        self.buffer.drain(..buffered);
        self.owed += samples - buffered;
    }
}

/// A clip's fade envelope at mix frame `frame`: 0 silent, 1 full.
fn fade_gain(clip_start: i64, end: u64, fade_in: u64, fade_out: u64, frame: u64) -> f32 {
    let mut gain = 1.0f32;
    if fade_in > 0 {
        gain = gain.min((frame as i64 - clip_start) as f32 / fade_in as f32);
    }
    if fade_out > 0 {
        gain = gain.min((end as i64 - frame as i64) as f32 / fade_out as f32);
    }
    gain.clamp(0.0, 1.0)
}

/// What the output thread and the editor share.
#[derive(Default)]
struct Mix {
    channels: usize,
    running: bool,
    voices: Vec<Voice>,
    /// Sample frames played since playback started, how many the last batch had, and when it went out.
    played: u64,
    batch: u64,
    played_at: Option<Instant>,
    /// When the editor last drew, and whether the sound stopped because that was too long ago.
    seen: Option<Instant>,
    stalled: bool,
    /// Whether the clock has started, and when playback asked for it (it waits for the first sound).
    rolling: bool,
    cued_at: Option<Instant>,
}

impl Mix {
    /// Writes the next batch of interleaved samples. Runs on the output thread.
    fn fill(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        if !self.running || self.stalled {
            return;
        }
        if self.seen.is_some_and(|seen| seen.elapsed() > STALE) {
            self.stalled = true;
            return;
        }
        let channels = self.channels.max(1);
        let frames = (out.len() / channels) as u64;
        let from = self.played;
        if !self.rolling {
            // Pre-roll: hold the clock until the sound due first has arrived, so sound and picture start together.
            let ready = self
                .voices
                .iter_mut()
                .filter(|voice| voice.next < from + frames)
                .all(|voice| {
                    voice.pull(1);
                    !voice.buffer.is_empty() || voice.done
                });
            if !ready && self.cued_at.is_some_and(|at| at.elapsed() < PREROLL) {
                return;
            }
            self.rolling = true;
        }
        for voice in &mut self.voices {
            if voice.next < from {
                // Added late: skip the sound that should already have played.
                voice.skip((from - voice.next) as usize * channels);
                voice.next = from;
            }
            let last = voice.end.min(from + frames);
            if voice.next >= last {
                continue;
            }
            let wanted = (last - voice.next) as usize * channels;
            voice.pull(wanted);
            let offset = (voice.next - from) as usize * channels;
            let have = wanted.min(voice.buffer.len());
            let (first, volume) = (voice.next, voice.volume);
            let (clip_start, end, fade_in, fade_out) =
                (voice.clip_start, voice.end, voice.fade_in, voice.fade_out);
            for (index, (slot, sample)) in out[offset..offset + have]
                .iter_mut()
                .zip(voice.buffer.drain(..have))
                .enumerate()
            {
                let gain = if fade_in > 0 || fade_out > 0 {
                    fade_gain(
                        clip_start,
                        end,
                        fade_in,
                        fade_out,
                        first + (index / channels) as u64,
                    )
                } else {
                    1.0
                };
                *slot += sample * volume * gain;
            }
            voice.owed += wanted - have;
            voice.next = last;
        }
        self.played = from + frames;
        self.batch = frames;
        self.played_at = Some(Instant::now());
        let played = self.played;
        self.voices.retain(|voice| voice.end > played);
        for sample in out.iter_mut() {
            *sample = sample.clamp(-1.0, 1.0);
        }
    }
}

struct Output {
    stream: cpal::Stream,
    rate: u32,
}

/// The editor's side of playback sound: opens the output device on first play, starts each clip's sound as the
/// playhead nears it, and tells the editor where the sound is.
#[derive(Default)]
pub struct Audio {
    mix: Arc<Mutex<Mix>>,
    output: Option<Output>,
    /// Why there's no sound, once opening the output failed. Playback then runs silently on the wall clock.
    pub failed: Option<String>,
    /// The voices' FFmpeg decoders with the timeline time their clip ends. They're stopped here, not on the output
    /// thread, because stopping a process waits for it.
    decoders: Vec<(f64, SoundStream)>,
    started: HashSet<String>,
    origin: f64,
    signature: u64,
}

/// Changes whenever what's audible changes: a clip moved, trimmed, muted or added.
fn signature(project: &Project) -> u64 {
    let mut hasher = DefaultHasher::new();
    for (clip, media) in project.audible_clips() {
        clip.id.hash(&mut hasher);
        media.path.hash(&mut hasher);
        for value in [
            clip.start,
            clip.source_in,
            clip.duration,
            clip.fade_in,
            clip.fade_out,
            clip.crossfade_in,
            clip.speed,
        ] {
            value.to_bits().hash(&mut hasher);
        }
        for value in [
            clip.volume,
            clip.sound.low,
            clip.sound.mid,
            clip.sound.high,
            clip.sound.pan,
        ] {
            value.to_bits().hash(&mut hasher);
        }
    }
    hasher.finish()
}

impl Audio {
    fn mix(&self) -> MutexGuard<'_, Mix> {
        self.mix
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts the sound at timeline time `from`. False when there's no sound output: use the wall clock then.
    pub fn play(&mut self, project: &Project, from: f64) -> bool {
        if self.output.is_none() && self.failed.is_none() {
            match open(self.mix.clone()) {
                Ok(output) => self.output = Some(output),
                Err(error) => self.failed = Some(error),
            }
        }
        self.stop_voices();
        if self.output.is_none() {
            return false;
        }
        self.origin = from;
        self.signature = signature(project);
        self.schedule(project, from);
        // The clock starts once the decoders are going, so starting them doesn't count as time played.
        {
            let mut mix = self.mix();
            mix.running = true;
            mix.played = 0;
            mix.batch = 0;
            mix.played_at = None;
            mix.seen = Some(Instant::now());
            mix.stalled = false;
            mix.rolling = false;
            mix.cued_at = Some(Instant::now());
        }
        if let Some(Err(error)) = self.output.as_ref().map(|output| output.stream.play()) {
            self.failed = Some(error.to_string());
            self.output = None;
            self.stop_voices();
            return false;
        }
        true
    }

    pub fn pause(&mut self) {
        self.mix().running = false;
        self.stop_voices();
        if let Some(output) = &self.output {
            let _ = output.stream.pause();
        }
    }

    fn stop_voices(&mut self) {
        self.mix().voices.clear();
        self.decoders.clear();
        self.started.clear();
    }

    /// The timeline time of the sound going out now, while playing with sound.
    pub fn now(&self) -> Option<f64> {
        let rate = self.output.as_ref()?.rate as f64;
        let mix = self.mix();
        if !mix.running {
            return None;
        }
        // Between batches, count on from the last one, but never past what it held.
        let since = mix.played_at.map_or(0.0, |at| {
            at.elapsed().as_secs_f64().min(mix.batch as f64 / rate)
        });
        Some(self.origin + mix.played as f64 / rate + since)
    }

    /// Call every frame while playing. Starts the sound of clips the playhead is nearing and starts over after an edit
    /// changed what's audible. False when the sound stopped because the editor went unseen: pause then.
    pub fn update(&mut self, project: &Project, playhead: f64) -> bool {
        if self.output.is_none() {
            return true;
        }
        {
            let mut mix = self.mix();
            if !mix.running {
                return true;
            }
            if mix.stalled {
                return false;
            }
            mix.seen = Some(Instant::now());
        }
        if signature(project) != self.signature {
            return self.play(project, playhead);
        }
        self.schedule(project, playhead);
        true
    }

    fn schedule(&mut self, project: &Project, playhead: f64) {
        let Some(rate) = self.output.as_ref().map(|output| output.rate) else {
            return;
        };
        self.decoders.retain(|(end, _)| *end > playhead);
        let channels = self.mix().channels.max(1) as u16;
        let origin = self.origin;
        let frame = |t: f64| ((t - origin).max(0.0) * rate as f64).round() as u64;
        let mut voices = Vec::new();
        for (clip, media) in project.audible_clips() {
            let crossfade_out = project.crossfade_after(&clip.id);
            let crossfade_in = project.crossfade_before(&clip.id).map_or(0.0, |(_, d)| d);
            let end = clip.end() + crossfade_out;
            if self.started.contains(&clip.id)
                || end <= playhead
                || clip.start > playhead + LOOKAHEAD
            {
                continue;
            }
            let begin = clip.start.max(playhead);
            let mut decoder = SoundStream::start(
                &media.path,
                clip.source_time(begin),
                end - begin,
                clip.speed,
                rate,
                channels,
                clip.sound.filter().as_deref(),
            );
            let frames = |seconds: f64| (seconds * rate as f64).round() as u64;
            voices.push(Voice {
                next: frame(begin),
                end: frame(end),
                volume: clip.volume,
                clip_start: ((clip.start - origin) * rate as f64).round() as i64,
                fade_in: frames(if crossfade_in > 0.0 {
                    crossfade_in
                } else {
                    clip.fade_in
                }),
                fade_out: frames(clip.fade_out.max(crossfade_out)),
                chunks: decoder.take_chunks(),
                buffer: VecDeque::new(),
                owed: 0,
                done: false,
            });
            self.decoders.push((end, decoder));
            self.started.insert(clip.id.clone());
        }
        if !voices.is_empty() {
            self.mix().voices.extend(voices);
        }
    }
}

fn open(mix: Arc<Mutex<Mix>>) -> Result<Output, String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("No sound output is connected.")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    mix.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .channels = config.channels as usize;
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, mix),
        SampleFormat::I16 => build::<i16>(&device, config, mix),
        SampleFormat::I32 => build::<i32>(&device, config, mix),
        SampleFormat::U16 => build::<u16>(&device, config, mix),
        other => {
            return Err(format!(
                "The sound output wants {other} samples, which StreamCuts can't make yet."
            ));
        }
    }?;
    Ok(Output {
        stream,
        rate: config.sample_rate,
    })
}

fn build<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mix: Arc<Mutex<Mix>>,
) -> Result<cpal::Stream, String> {
    let mut scratch = Vec::new();
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                scratch.resize(data.len(), 0.0);
                match mix.lock() {
                    Ok(mut mix) => mix.fill(&mut scratch),
                    Err(_) => scratch.fill(0.0),
                }
                for (out, sample) in data.iter_mut().zip(&scratch) {
                    *out = T::from_sample(*sample);
                }
            },
            |error| eprintln!("StreamCuts sound: {error}"),
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{SyncSender, sync_channel};

    fn voice(next: u64, end: u64, volume: f32) -> (Voice, SyncSender<Vec<f32>>) {
        let (sender, chunks) = sync_channel(8);
        (
            Voice {
                next,
                end,
                volume,
                clip_start: next as i64,
                fade_in: 0,
                fade_out: 0,
                chunks,
                buffer: VecDeque::new(),
                owed: 0,
                done: false,
            },
            sender,
        )
    }

    fn mix(channels: usize, voices: Vec<Voice>) -> Mix {
        Mix {
            channels,
            running: true,
            voices,
            ..Mix::default()
        }
    }

    #[test]
    fn places_voices_by_timeline_sample_and_scales_them() {
        let (a, a_in) = voice(2, 100, 0.5);
        let (b, b_in) = voice(0, 3, 1.0);
        a_in.send(vec![0.4, 0.4, 0.4, 0.4]).unwrap();
        b_in.send(vec![0.1, 0.1, 0.1]).unwrap();
        let mut mix = mix(1, vec![a, b]);
        let mut out = [9.0; 4];
        mix.fill(&mut out);
        assert_eq!(out, [0.1, 0.1, 0.1 + 0.2, 0.2]);
        assert_eq!(mix.played, 4);
        // b ended at frame 3, so only a is left.
        assert_eq!(mix.voices.len(), 1);
    }

    #[test]
    fn late_sound_is_skipped_so_the_voice_stays_in_time() {
        let (v, input) = voice(0, 100, 1.0);
        let mut mix = mix(2, vec![v]);
        let mut out = [0.0; 4];
        mix.fill(&mut out);
        assert_eq!(out, [0.0; 4], "nothing decoded yet: silence");
        // The first two frames arrive too late and are dropped; the next frame plays on time.
        input.send(vec![1.0, 1.0, 1.0, 1.0, 0.3, 0.6]).unwrap();
        mix.fill(&mut out);
        assert_eq!(out, [0.3, 0.6, 0.0, 0.0]);
    }

    #[test]
    fn the_clock_waits_for_the_first_sound() {
        let (v, input) = voice(0, 100, 1.0);
        let (later, _later_input) = voice(50, 100, 1.0);
        let mut mix = mix(1, vec![v, later]);
        mix.cued_at = Some(Instant::now());
        let mut out = [0.0; 2];
        mix.fill(&mut out);
        assert_eq!((out, mix.played), ([0.0; 2], 0), "nothing yet: hold still");
        // Only the voice due now counts; the later one may still be on its way.
        input.send(vec![0.1, 0.2, 0.3]).unwrap();
        mix.fill(&mut out);
        assert_eq!((out, mix.played), ([0.1, 0.2], 2), "nothing skipped");
    }

    #[test]
    fn a_failed_voice_doesnt_hold_up_playback() {
        let (v, input) = voice(0, 100, 1.0);
        drop(input);
        let mut mix = mix(1, vec![v]);
        mix.cued_at = Some(Instant::now());
        let mut out = [0.0; 2];
        mix.fill(&mut out);
        assert_eq!(mix.played, 2);
    }

    #[test]
    fn a_voice_added_after_its_start_skips_ahead() {
        let mut mix = mix(1, Vec::new());
        mix.played = 10;
        let (v, input) = voice(8, 100, 1.0);
        input.send(vec![0.1, 0.2, 0.3, 0.4]).unwrap();
        mix.voices.push(v);
        let mut out = [0.0; 2];
        mix.fill(&mut out);
        assert_eq!(out, [0.3, 0.4]);
    }

    #[test]
    fn silent_and_still_when_paused_or_unseen() {
        let (v, input) = voice(0, 100, 1.0);
        input.send(vec![0.5; 8]).unwrap();
        let mut mix = mix(1, vec![v]);
        mix.running = false;
        let mut out = [0.0; 4];
        mix.fill(&mut out);
        assert_eq!((out, mix.played), ([0.0; 4], 0));
        mix.running = true;
        mix.seen = Some(Instant::now() - Duration::from_secs(2));
        mix.fill(&mut out);
        assert_eq!((out, mix.played, mix.stalled), ([0.0; 4], 0, true));
    }

    /// Needs FFmpeg and a sound output (`cargo test -- --ignored`): plays a tone too quiet to hear and checks that the
    /// output's clock keeps time and FFmpeg keeps up.
    #[test]
    #[ignore]
    fn the_output_clock_keeps_time() {
        let dir = std::env::temp_dir().join(format!("streamcuts-audio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tone = dir.join("tone.wav");
        let made = crate::ffmpeg::command(&crate::ffmpeg::ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=4"])
            .arg(&tone)
            .status()
            .unwrap();
        assert!(made.success());
        let mut project = Project::new("Tone");
        let id = project.add_media(crate::ffmpeg::probe(&tone).unwrap());
        // Played at 1.5x: the sound clock still keeps wall time; FFmpeg just reads faster.
        project.place(&id, None, 0.0).unwrap();
        for clip in project
            .tracks
            .iter_mut()
            .flat_map(|track| track.clips.iter_mut())
        {
            clip.volume = 0.001;
            clip.speed = 1.5;
            clip.duration /= 1.5;
        }
        let mut audio = Audio::default();
        assert!(audio.play(&project, 0.5), "{:?}", audio.failed);
        let tick = |audio: &mut Audio| {
            let now = audio.now().unwrap();
            assert!(audio.update(&project, now), "the sound stopped at {now:.3}");
            std::thread::sleep(Duration::from_millis(16));
        };
        // The clock holds still until the first sound arrives (pre-roll), then keeps wall time.
        let cued = Instant::now();
        while audio.now().unwrap() <= 0.5 && cued.elapsed() < Duration::from_secs(3) {
            tick(&mut audio);
        }
        let (started, from) = (Instant::now(), audio.now().unwrap());
        assert!(from > 0.5, "the sound never started");
        while started.elapsed() < Duration::from_millis(1200) {
            tick(&mut audio);
        }
        let (now, expected) = (audio.now().unwrap(), from + started.elapsed().as_secs_f64());
        assert!(
            (now - expected).abs() < 0.1,
            "sound clock at {now:.3}, wall clock at {expected:.3}"
        );
        {
            let mix = audio.mix();
            assert_eq!(mix.voices.len(), 1);
            assert!(
                mix.voices[0].owed < 4_800 * mix.channels,
                "FFmpeg fell behind by {} samples",
                mix.voices[0].owed
            );
        }
        audio.pause();
        assert!(audio.now().is_none());
        drop(audio);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fades_shape_the_sound() {
        let (mut v, input) = voice(0, 8, 1.0);
        (v.fade_in, v.fade_out) = (4, 2);
        input.send(vec![1.0; 8]).unwrap();
        let mut mix = mix(1, vec![v]);
        let mut out = [0.0; 8];
        mix.fill(&mut out);
        assert_eq!(out, [0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 1.0, 0.5]);
    }

    #[test]
    fn loud_mixes_are_clipped() {
        let (a, a_in) = voice(0, 100, 1.0);
        let (b, b_in) = voice(0, 100, 1.0);
        a_in.send(vec![0.8, -0.8]).unwrap();
        b_in.send(vec![0.8, -0.8]).unwrap();
        let mut mix = mix(1, vec![a, b]);
        let mut out = [0.0; 2];
        mix.fill(&mut out);
        assert_eq!(out, [1.0, -1.0]);
    }
}
