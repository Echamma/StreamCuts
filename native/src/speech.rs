//! What's said on the timeline, word by word, for Codex. Each media file's words are worked out once, for the stretches
//! the timeline plays, and kept in the app's data folder (by file, like waveforms), so the timeline's transcript after
//! any edit comes from the cache at once. Refreshing works them out again.
//!
//! The speech model is faster-whisper, run by `speech.py`, which StreamCuts carries inside itself: one Python run per
//! transcription, on the graphics card when it can.

use crate::cache;
use crate::ffmpeg;
use crate::project::{MediaKind, Project, TrackKind};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

const SCRIPT: &str = include_str!("speech.py");
/// Stretches are transcribed in pieces of at most this many seconds.
const PIECE: f64 = 600.0;
/// Extra sound each side of a piece, so a word on its edge is heard whole.
const PAD: f64 = 1.0;

/// A word said on the timeline (or in a source file), in seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spoken {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A media file's words so far, in source seconds, and the stretches they cover.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Heard {
    covered: Vec<(f64, f64)>,
    words: Vec<Spoken>,
}

fn entry(data_dir: &Path, media: &Path) -> Option<PathBuf> {
    cache::entry(data_dir, media, "speech.json")
}

fn heard(data_dir: &Path, media: &Path) -> Heard {
    entry(data_dir, media)
        .and_then(|e| cache::read(&e))
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The clips whose speech counts: sound that plays (not muted, not a video whose sound went to an audio track), from
/// media that isn't one of Codex's own additions (in `skip`), at least a couple of seconds long.
fn speaking_clips<'a>(project: &'a Project, skip: &Path) -> Vec<(&'a crate::project::Clip, &'a crate::project::Media)> {
    project
        .tracks
        .iter()
        .filter(|t| !t.muted && !(t.kind == TrackKind::Video && t.hidden))
        .flat_map(|t| t.clips.iter())
        .filter_map(|clip| Some((clip, project.media(&clip.media_id)?)))
        .filter(|(clip, media)| {
            media.has_audio
                && media.kind != MediaKind::Image
                && clip.volume > 0.0
                && !project.sounds_elsewhere(clip)
                && !media.path.starts_with(skip)
                && media.duration >= 2.0
        })
        .collect()
}

/// For each media file, the stretches of it the timeline plays, merged.
pub fn needed(project: &Project, skip: &Path) -> Vec<(PathBuf, Vec<(f64, f64)>)> {
    let mut by_file: Vec<(PathBuf, Vec<(f64, f64)>)> = Vec::new();
    for (clip, media) in speaking_clips(project, skip) {
        let stretch = (clip.source_in, clip.source_in + clip.source_length());
        match by_file.iter_mut().find(|(p, _)| *p == media.path) {
            Some((_, list)) => list.push(stretch),
            None => by_file.push((media.path.clone(), vec![stretch])),
        }
    }
    for (_, list) in &mut by_file {
        *list = merge(std::mem::take(list), 0.5);
    }
    by_file
}

fn merge(mut list: Vec<(f64, f64)>, join: f64) -> Vec<(f64, f64)> {
    list.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in list {
        match out.last_mut() {
            Some(last) if a <= last.1 + join => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// What of `wanted` isn't in `covered`, in pieces of at most `PIECE` seconds (shorter bits than half a second are let
/// go).
fn missing(wanted: &[(f64, f64)], covered: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut gaps = Vec::new();
    for &(a, b) in wanted {
        let mut from = a;
        for &(c, d) in covered.iter().filter(|(c, d)| *d > a && *c < b) {
            if c > from {
                gaps.push((from, c.min(b)));
            }
            from = from.max(d);
        }
        if from < b {
            gaps.push((from, b));
        }
    }
    let mut pieces = Vec::new();
    for (a, b) in gaps.into_iter().filter(|(a, b)| b - a >= 0.5) {
        let mut from = a;
        while from < b {
            let to = (from + PIECE).min(b);
            pieces.push((from, to));
            from = to;
        }
    }
    pieces
}

/// How many seconds of speech `transcribe` would have to work out (all of it when `refresh`).
pub fn to_do(data_dir: &Path, needed: &[(PathBuf, Vec<(f64, f64)>)], refresh: bool) -> f64 {
    needed
        .iter()
        .map(|(path, wanted)| {
            let covered = if refresh { Vec::new() } else { heard(data_dir, path).covered };
            missing(wanted, &covered).iter().map(|(a, b)| b - a).sum::<f64>()
        })
        .sum()
}

/// Works out the words of whatever of `needed` isn't known yet (all of it, forgetting what was, when `refresh`), in one
/// run of the speech model. `progress` hears how far it got. Blocking and slow: run it off the UI thread.
pub fn transcribe(
    data_dir: &Path,
    needed: &[(PathBuf, Vec<(f64, f64)>)],
    refresh: bool,
    progress: &dyn Fn(String),
) -> Result<(), String> {
    let work = std::env::temp_dir().join(format!("streamcuts-speech-{}", crate::project::new_id()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = transcribe_in(&work, data_dir, needed, refresh, progress);
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn transcribe_in(
    work: &Path,
    data_dir: &Path,
    needed: &[(PathBuf, Vec<(f64, f64)>)],
    refresh: bool,
    progress: &dyn Fn(String),
) -> Result<(), String> {
    // What to cut out of which file: (file, its words so far, the pieces).
    let mut plan = Vec::new();
    for (path, wanted) in needed {
        let mut known = if refresh { Heard::default() } else { heard(data_dir, path) };
        if refresh {
            known.covered.clear();
        }
        let pieces = missing(wanted, &known.covered);
        if !pieces.is_empty() {
            plan.push((path.clone(), known, pieces));
        }
    }
    if plan.is_empty() {
        return Ok(());
    }
    let total: usize = plan.iter().map(|(_, _, p)| p.len()).sum();
    let mut manifest = Vec::new();
    let mut n = 0;
    for (path, _, pieces) in &plan {
        for &(a, b) in pieces {
            progress(format!("Getting the sound out ({}/{total})", n + 1));
            let from = (a - PAD).max(0.0);
            let wav = work.join(format!("{n}.wav"));
            let cut = ffmpeg::command(&ffmpeg::ffmpeg())
                .args(["-v", "error", "-y", "-ss", &format!("{from:.3}")])
                .arg("-i")
                .arg(path)
                .args(["-t", &format!("{:.3}", b + PAD - from), "-vn", "-ac", "1", "-ar", "16000"])
                .arg(&wav)
                .output()
                .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
            if !cut.status.success() || !wav.is_file() {
                return Err(format!("Couldn't get the sound out of {}.", path.display()));
            }
            manifest.push(serde_json::json!({"wav": wav, "out": work.join(format!("{n}.json"))}));
            n += 1;
        }
    }
    let script = work.join("speech.py");
    std::fs::write(&script, SCRIPT).map_err(|e| e.to_string())?;
    let list = work.join("manifest.json");
    std::fs::write(&list, serde_json::to_vec(&manifest).unwrap()).map_err(|e| e.to_string())?;
    progress(format!("Listening (0/{total}); the speech model is loading"));
    let mut child = ffmpeg::command(&crate::transcribe::python())
        .arg(&script)
        .arg(&list)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Python couldn't start ({e}). Install Python with faster-whisper, or set STREAMCUTS_PYTHON."))?;
    let stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut BufReader::new(stderr), &mut text);
        text
    });
    let mut finished = 0;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        if line.contains("\"done\"") {
            finished += 1;
            let on = if line.contains("\"cuda\"") { "graphics card" } else { "processor" };
            progress(format!("Listening ({finished}/{total}, on the {on})"));
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        let last = errors.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("no details");
        return Err(format!("The speech model failed: {last}"));
    }
    // Each piece's words, back in source seconds, into its file's cache entry.
    let mut n = 0;
    for (path, mut known, pieces) in plan {
        for (a, b) in pieces {
            let from = (a - PAD).max(0.0);
            let out = work.join(format!("{n}.json"));
            n += 1;
            #[derive(Deserialize)]
            struct Out {
                words: Vec<(f64, f64, String)>,
            }
            let words: Out = serde_json::from_slice(&std::fs::read(&out).map_err(|e| e.to_string())?)
                .map_err(|e| format!("The speech model said something unexpected ({e})."))?;
            // Words whose middle is in the piece (the padding's words belong to the pieces either side).
            known.words.retain(|w| (w.start + w.end) / 2.0 < a || (w.start + w.end) / 2.0 >= b);
            known.words.extend(words.words.into_iter().filter_map(|(s, e, text)| {
                let (s, e) = (from + s, from + e);
                let middle = (s + e) / 2.0;
                (middle >= a && middle < b).then_some(Spoken { start: s, end: e, text })
            }));
            known.covered.push((a, b));
        }
        known.words.sort_by(|x, y| x.start.total_cmp(&y.start));
        known.covered = merge(known.covered, 0.01);
        if let Some(e) = entry(data_dir, &path) {
            cache::write(&e, &serde_json::to_vec(&known).unwrap());
        }
    }
    Ok(())
}

/// The words said on the timeline, in timeline seconds, from what's known (stretches never transcribed are left out).
pub fn timeline_words(data_dir: &Path, project: &Project, skip: &Path) -> Vec<Spoken> {
    let mut cached: Vec<(PathBuf, Heard)> = Vec::new();
    let mut out: Vec<Spoken> = Vec::new();
    for (clip, media) in speaking_clips(project, skip) {
        if !cached.iter().any(|(p, _)| *p == media.path) {
            cached.push((media.path.clone(), heard(data_dir, &media.path)));
        }
        let known = &cached.iter().find(|(p, _)| *p == media.path).unwrap().1;
        let (from, to) = (clip.source_in, clip.source_in + clip.source_length());
        for w in known.words.iter().filter(|w| (w.start + w.end) / 2.0 >= from && (w.start + w.end) / 2.0 < to) {
            let at = |s: f64| clip.start + (s.clamp(from, to) - from) / clip.speed;
            let word = Spoken { start: at(w.start), end: at(w.end), text: w.text.clone() };
            // The same footage on two tracks at once (a Short's layers) says each word once.
            if !out.iter().rev().take(40).any(|o| o.text == word.text && (o.start - word.start).abs() < 0.05) {
                out.push(word);
            }
        }
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

/// Words grouped into lines at pauses (or every so many words), as "[start-end] text".
pub fn lines(words: &[Spoken]) -> Vec<(f64, f64, String)> {
    let mut out: Vec<(f64, f64, String)> = Vec::new();
    let mut count = 0;
    for w in words {
        match out.last_mut() {
            Some(line) if w.start - line.1 < 0.7 && count < 16 => {
                line.1 = w.end;
                line.2.push(' ');
                line.2.push_str(&w.text);
                count += 1;
            }
            _ => {
                out.push((w.start, w.end, w.text.clone()));
                count = 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_isnt_known_is_transcribed_in_pieces() {
        assert_eq!(missing(&[(0.0, 10.0)], &[(2.0, 4.0), (6.0, 7.0)]), vec![(0.0, 2.0), (4.0, 6.0), (7.0, 10.0)]);
        assert_eq!(missing(&[(0.0, 10.0)], &[(0.0, 9.8)]), Vec::<(f64, f64)>::new(), "a sliver is let go");
        assert_eq!(missing(&[(0.0, 1300.0)], &[]).len(), 3, "ten-minute pieces");
        assert_eq!(merge(vec![(5.0, 6.0), (0.0, 2.0), (2.3, 3.0)], 0.5), vec![(0.0, 3.0), (5.0, 6.0)]);
    }

    #[test]
    fn words_land_where_their_clips_play_on_the_timeline() {
        use crate::project::{Attributes, Media};
        let dir = std::env::temp_dir().join(format!("streamcuts-speech-{}", crate::project::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("talk.mp4");
        std::fs::write(&file, b"not really a video").unwrap();
        let mut project = Project::new("Talk");
        let media = project.add_media(Media {
            id: "m".into(),
            path: file.clone(),
            name: "talk.mp4".into(),
            kind: MediaKind::Video,
            duration: 60.0,
            width: 1920,
            height: 1080,
            has_audio: true,
            frame_rate: 30.0,
            attributes: Attributes::default(),
        });
        // Two pieces of the source: 10-20 s at the start of the timeline, then 40-50 s at double speed.
        let first = project.place(&media, Some(0), 0.0).unwrap();
        let second = project.place(&media, Some(0), 10.0).unwrap();
        for (id, start, source_in, duration, speed) in [(&first, 0.0, 10.0, 10.0, 1.0), (&second, 10.0, 40.0, 5.0, 2.0)] {
            let clip = project.clip_mut(id).unwrap();
            (clip.start, clip.source_in, clip.duration, clip.speed) = (start, source_in, duration, speed);
        }
        let wanted = needed(&project, Path::new("Z:/nowhere"));
        assert_eq!(wanted, vec![(file.clone(), vec![(10.0, 20.0), (40.0, 50.0)])]);
        let known = Heard {
            covered: vec![(0.0, 60.0)],
            words: [(5.0, "before"), (12.0, "hello"), (19.0, "there"), (30.0, "cut"), (44.0, "fast")]
                .into_iter()
                .map(|(t, w)| Spoken { start: t, end: t + 0.5, text: w.into() })
                .collect(),
        };
        cache::write(&entry(&dir, &file).unwrap(), &serde_json::to_vec(&known).unwrap());
        let words = timeline_words(&dir, &project, Path::new("Z:/nowhere"));
        let said: Vec<(f64, &str)> = words.iter().map(|w| (w.start, w.text.as_str())).collect();
        assert_eq!(said, [(2.0, "hello"), (9.0, "there"), (12.0, "fast")]);
        assert_eq!(to_do(&dir, &wanted, false), 0.0);
        assert_eq!(to_do(&dir, &wanted, true), 20.0);
        // Codex's own additions don't count.
        assert!(needed(&project, &dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
