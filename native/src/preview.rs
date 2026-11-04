//! The preview: the picture in front at the playhead. Paused, it asks the worker for exact stills as you scrub; playing,
//! it reads a continuous `FrameStream` for the clip in front and shows the newest frame that is due. The next clip's
//! stream starts a second early, so a cut doesn't wait for FFmpeg to start.

use crate::ffmpeg::{self, Frame, FrameStream};
use crate::project::{Clip, Media, MediaKind, Picture, Project, TrackKind};
use crate::scopes::Scopes;
use crate::worker::{Job, StillBlend, StillKey, Worker};
use egui::{ColorImage, TextureHandle, TextureOptions};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// A still that takes longer than this gets a stand-in from the filmstrip.
const SLOW_STILL: std::time::Duration = std::time::Duration::from_millis(150);

/// How far ahead of a cut the next clip's picture starts decoding.
const PRELOAD: f64 = 1.0;

struct Playing {
    clip_id: String,
    picture: Picture,
    speed: f64,
    stream: FrameStream,
    ahead: Option<Frame>,
    last: Option<Frame>,
    shown: f64,
}

impl Playing {
    /// Plays `clip` from `path`: its media, or that media's editing proxy. `looped` is an animated picture's loop length.
    fn start(
        project: &Project,
        clip: &Clip,
        path: &Path,
        source: f64,
        looped: Option<f64>,
    ) -> Self {
        let (width, height) = decode_size(project);
        let stream = FrameStream::start(
            path,
            source,
            project.fps,
            width,
            height,
            clip.picture(),
            clip.speed,
            looped,
        );
        Self {
            clip_id: clip.id.clone(),
            picture: clip.picture(),
            speed: clip.speed,
            stream,
            ahead: None,
            last: None,
            shown: source,
        }
    }

    fn advance(&mut self, source: f64, half_frame: f64) -> bool {
        let mut changed = false;
        loop {
            let frame = match self
                .ahead
                .take()
                .or_else(|| self.stream.frames.try_recv().ok())
            {
                Some(frame) => frame,
                None => break,
            };
            if frame.time <= source + half_frame {
                self.shown = frame.time;
                self.last = Some(frame);
                changed = true;
            } else {
                self.ahead = Some(frame);
                break;
            }
        }
        changed
    }
}

#[derive(Default)]
pub struct Preview {
    pub texture: Option<TextureHandle>,
    shown: Option<StillKey>,
    waiting: Option<StillKey>,
    asked_at: Option<Instant>,
    playing: Option<Playing>,
    transition: Option<Playing>,
    next: Option<Playing>,
    /// Nothing is in front at the playhead.
    pub blank: bool,
    /// Editing proxies by media id: playback reads these instead of the originals. Paused stills (and exports) still
    /// come from the originals, at full quality.
    pub proxies: HashMap<String, PathBuf>,
    /// The histogram and waveform of what's shown, while they're on.
    pub scopes: Scopes,
    /// The video track this preview shows, or None for whichever clip is in front (the main preview). Tracks below
    /// a placed clip get a preview of their own (see `Project::layers_at`).
    pub track: Option<usize>,
}

/// What playback reads for `media`: its editing proxy when it has one.
fn playback_path<'a>(proxies: &'a HashMap<String, PathBuf>, media: &'a Media) -> &'a Path {
    proxies.get(&media.id).map_or(&media.path, |proxy| proxy)
}

/// The size previews are decoded at: the project's shape, fitted in 960×540 (or 540×960 for vertical).
pub fn decode_size(project: &Project) -> (u32, u32) {
    let (w, h) = (project.width as f32, project.height as f32);
    let scale = (960.0 / w.max(h)).min(1.0);
    let even = |v: f32| ((v * scale / 2.0).round() as u32 * 2).max(2);
    (even(w), even(h))
}

impl Preview {
    /// A preview of video track `track` only.
    pub fn of_track(track: usize) -> Self {
        Self {
            track: Some(track),
            ..Self::default()
        }
    }

    /// The clip this preview shows at `t`.
    fn clip<'a>(&self, project: &'a Project, t: f64) -> Option<(&'a Clip, &'a Media)> {
        match self.track {
            Some(track) => project.clip_on(track, t),
            None => project.front_clip(t),
        }
    }

    fn show(
        texture: &mut Option<TextureHandle>,
        scopes: &mut Scopes,
        ctx: &egui::Context,
        frame: &Frame,
    ) {
        scopes.update(ctx, frame);
        let image = ColorImage::from_rgba_unmultiplied(frame.size, &frame.rgba);
        match texture {
            Some(texture) => texture.set(image, TextureOptions::LINEAR),
            None => {
                *texture =
                    Some(ctx.load_texture("streamcuts-preview", image, TextureOptions::LINEAR))
            }
        }
    }

    /// A still the worker finished.
    pub fn still_done(&mut self, ctx: &egui::Context, key: StillKey, frame: Result<Frame, String>) {
        if self.waiting.as_ref() != Some(&key) {
            return;
        }
        self.waiting = None;
        if let Ok(frame) = frame {
            if self.playing.is_none() {
                Self::show(&mut self.texture, &mut self.scopes, ctx, &frame);
                self.shown = Some(key);
            }
        }
    }

    /// Brings the preview to timeline time `t`.
    pub fn update(
        &mut self,
        ctx: &egui::Context,
        project: &Project,
        t: f64,
        playing: bool,
        worker: &Worker,
    ) {
        if playing {
            self.preload(project, t);
        } else {
            self.next = None;
        }
        let Some((clip, media)) = self.clip(project, t) else {
            self.blank = true;
            self.playing = None;
            self.transition = None;
            self.shown = None;
            self.waiting = None;
            return;
        };
        self.blank = false;
        let source = clip.source_time(t);
        let (width, height) = decode_size(project);
        if playing && (media.kind == MediaKind::Video || media.loop_length().is_some()) {
            self.waiting = None;
            let transition = project.crossfade_at(t);
            let restart = match &self.playing {
                Some(p) => {
                    p.clip_id != clip.id
                        || p.picture != clip.picture()
                        || p.speed != clip.speed
                        || (source - p.shown).abs() > 0.75
                }
                None => true,
            };
            if restart {
                let preloaded = self.next.take().filter(|next| {
                    next.clip_id == clip.id
                        && next.picture == clip.picture()
                        && next.speed == clip.speed
                        && (source - next.shown).abs() <= 0.75
                });
                if let Some((outgoing, _, _, _, _)) = transition {
                    self.transition = self.playing.take().filter(|p| p.clip_id == outgoing.id);
                }
                self.playing = Some(preloaded.unwrap_or_else(|| {
                    Playing::start(
                        project,
                        clip,
                        playback_path(&self.proxies, media),
                        source,
                        media.loop_length(),
                    )
                }));
            }
            let half_frame = 0.5 * clip.speed / project.fps as f64;
            let changed = self
                .playing
                .as_mut()
                .is_some_and(|p| p.advance(source, half_frame));
            if let Some((outgoing, outgoing_media, _, _, progress)) = transition {
                let old_source = outgoing.source_time(t);
                if self
                    .transition
                    .as_ref()
                    .is_none_or(|p| p.clip_id != outgoing.id)
                {
                    self.transition = Some(Playing::start(
                        project,
                        outgoing,
                        playback_path(&self.proxies, outgoing_media),
                        old_source,
                        outgoing_media.loop_length(),
                    ));
                }
                self.transition
                    .as_mut()
                    .unwrap()
                    .advance(old_source, 0.5 * outgoing.speed / project.fps as f64);
                if let (Some(old), Some(new)) = (
                    self.transition.as_ref().and_then(|p| p.last.as_ref()),
                    self.playing.as_ref().and_then(|p| p.last.as_ref()),
                ) {
                    let frame =
                        ffmpeg::crossfade_frames(old, new, progress as f32, clip.transition);
                    Self::show(&mut self.texture, &mut self.scopes, ctx, &frame);
                    self.shown = None;
                }
            } else {
                let had_transition = self.transition.take().is_some();
                if changed || had_transition {
                    if let Some(frame) = self.playing.as_ref().and_then(|p| p.last.as_ref()) {
                        Self::show(&mut self.texture, &mut self.scopes, ctx, frame);
                        self.shown = None;
                    }
                }
            }
            return;
        }
        self.playing = None;
        self.transition = None;
        // A still picture has one frame; an animated one shows where its loop has got to.
        let shows = match media.kind {
            MediaKind::Image => media
                .loop_length()
                .map_or(0.0, |length| source.rem_euclid(length)),
            _ => source,
        };
        let frame_number = (shows * project.fps as f64).round() as i64;
        // Stills are kept by how they're shown, so changing a clip's framing or color fetches it again.
        let picture = clip.picture();
        let blend = project
            .crossfade_at(t)
            .map(|(outgoing, outgoing_media, _, _, progress)| StillBlend {
                path: outgoing_media.path.clone(),
                at: outgoing.source_time(t),
                picture: outgoing.picture(),
                progress: progress as f32,
                transition: clip.transition,
            });
        let framed = if blend.is_some() {
            format!("{} {picture:?} {:?} {:.3}", media.id, clip.transition, t)
        } else if picture == Picture::default() {
            media.id.clone()
        } else {
            format!("{} {picture:?}", media.id)
        };
        let key: StillKey = (framed, frame_number);
        if self.shown.as_ref() != Some(&key) && self.waiting.as_ref() != Some(&key) {
            let at = frame_number as f64 / project.fps as f64;
            worker.send(Job::Still {
                key: key.clone(),
                path: media.path.clone(),
                at,
                width,
                height,
                picture,
                blend,
            });
            self.waiting = Some(key);
            self.asked_at = Some(Instant::now());
        }
        // Draw again once a slow still has kept us waiting long enough for the stand-in (just past the mark: egui
        // times a repaint from the start of the frame that asked).
        if let Some(asked) = self.asked_at.filter(|_| self.waiting.is_some()) {
            if let Some(left) = SLOW_STILL.checked_sub(asked.elapsed()) {
                ctx.request_repaint_after(left + std::time::Duration::from_millis(10));
            }
        }
    }

    /// Starts decoding the clip that comes in front next, if that happens within `PRELOAD` seconds.
    fn preload(&mut self, project: &Project, t: f64) {
        let current = self.clip(project, t).map(|(clip, _)| clip.id.clone());
        // What's in front changes only where a video clip starts or ends.
        let mut changes: Vec<f64> = project
            .tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Video)
            .flat_map(|track| track.clips.iter().flat_map(|clip| [clip.start, clip.end()]))
            .filter(|&at| at > t && at <= t + PRELOAD)
            .collect();
        changes.sort_by(f64::total_cmp);
        let upcoming = changes.into_iter().find_map(|at| {
            self.clip(project, at)
                .filter(|(clip, _)| Some(&clip.id) != current.as_ref())
                .map(|(clip, media)| (at, clip, media))
        });
        let Some((at, clip, media)) = upcoming else {
            return;
        };
        if (media.kind != MediaKind::Video && media.loop_length().is_none())
            || self
                .next
                .as_ref()
                .is_some_and(|next| next.clip_id == clip.id)
        {
            return;
        }
        self.next = Some(Playing::start(
            project,
            clip,
            playback_path(&self.proxies, media),
            clip.source_time(at),
            media.loop_length(),
        ));
    }

    /// Whether a still has been on its way for a while (the picture shown is from somewhere else). Quick stills don't
    /// count, so a fast FFmpeg doesn't flicker between a stand-in and the real picture.
    pub fn waiting(&self) -> bool {
        self.waiting.is_some()
            && self.playing.is_none()
            && self.asked_at.is_some_and(|at| at.elapsed() > SLOW_STILL)
    }

    /// Forgets the picture so the next update fetches it again (after the project's shape changes).
    pub fn reset(&mut self) {
        self.shown = None;
        self.waiting = None;
        self.playing = None;
        self.transition = None;
        self.next = None;
        self.texture = None;
    }
}

/// The playhead's clock while playing: wall time since play started.
pub struct Clock {
    pub playing: bool,
    from: f64,
    since: Instant,
}

impl Default for Clock {
    fn default() -> Self {
        Self {
            playing: false,
            from: 0.0,
            since: Instant::now(),
        }
    }
}

impl Clock {
    pub fn play(&mut self, from: f64) {
        self.playing = true;
        self.from = from;
        self.since = Instant::now();
    }
    pub fn pause(&mut self) {
        self.playing = false;
    }
    pub fn now(&self) -> f64 {
        self.from + self.since.elapsed().as_secs_f64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_still_cannot_replace_the_requested_frame() {
        let ctx = egui::Context::default();
        let mut preview = Preview {
            waiting: Some(("clip".into(), 12)),
            ..Default::default()
        };
        let frame = || Frame {
            time: 0.0,
            size: [1, 1],
            rgba: vec![0, 0, 0, 255],
        };
        preview.still_done(&ctx, ("clip".into(), 11), Ok(frame()));
        assert_eq!(preview.waiting, Some(("clip".into(), 12)));
        assert!(preview.texture.is_none());
        preview.still_done(&ctx, ("clip".into(), 12), Ok(frame()));
        assert!(preview.waiting.is_none());
        assert_eq!(preview.shown, Some(("clip".into(), 12)));
    }
}
