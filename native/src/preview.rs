//! The preview: the picture in front at the playhead. Paused, it asks the worker for exact stills as you scrub; playing,
//! it reads a continuous `FrameStream` for the clip in front and shows the newest frame that is due. The next clip's
//! stream starts a second early, so a cut doesn't wait for FFmpeg to start.

use crate::ffmpeg::{Frame, FrameStream};
use crate::project::{Clip, Media, MediaKind, Project, TrackKind};
use crate::worker::{Job, StillKey, Worker};
use egui::{ColorImage, TextureHandle, TextureOptions};
use std::time::Instant;

/// How far ahead of a cut the next clip's picture starts decoding.
const PRELOAD: f64 = 1.0;

struct Playing {
    clip_id: String,
    stream: FrameStream,
    ahead: Option<Frame>,
    shown: f64,
}

impl Playing {
    fn start(project: &Project, clip: &Clip, media: &Media, source: f64) -> Self {
        let (width, height) = decode_size(project);
        let stream = FrameStream::start(&media.path, source, project.fps, width, height);
        Self { clip_id: clip.id.clone(), stream, ahead: None, shown: source }
    }
}

#[derive(Default)]
pub struct Preview {
    pub texture: Option<TextureHandle>,
    shown: Option<StillKey>,
    waiting: Option<StillKey>,
    playing: Option<Playing>,
    next: Option<Playing>,
    /// Nothing is in front at the playhead.
    pub blank: bool,
}

/// The size previews are decoded at: the project's shape, fitted in 960×540 (or 540×960 for vertical).
pub fn decode_size(project: &Project) -> (u32, u32) {
    let (w, h) = (project.width as f32, project.height as f32);
    let scale = (960.0 / w.max(h)).min(1.0);
    let even = |v: f32| ((v * scale / 2.0).round() as u32 * 2).max(2);
    (even(w), even(h))
}

impl Preview {
    fn show(&mut self, ctx: &egui::Context, frame: &Frame) {
        let image = ColorImage::from_rgba_unmultiplied(frame.size, &frame.rgba);
        match &mut self.texture {
            Some(texture) => texture.set(image, TextureOptions::LINEAR),
            None => self.texture = Some(ctx.load_texture("streamcuts-preview", image, TextureOptions::LINEAR)),
        }
    }

    /// A still the worker finished.
    pub fn still_done(&mut self, ctx: &egui::Context, key: StillKey, frame: Result<Frame, String>) {
        if self.waiting.as_ref() == Some(&key) {
            self.waiting = None;
        }
        if let Ok(frame) = frame {
            if self.playing.is_none() {
                self.show(ctx, &frame);
                self.shown = Some(key);
            }
        }
    }

    /// Brings the preview to timeline time `t`.
    pub fn update(&mut self, ctx: &egui::Context, project: &Project, t: f64, playing: bool, worker: &Worker) {
        if playing {
            self.preload(project, t);
        } else {
            self.next = None;
        }
        let Some((clip, media)) = project.front_clip(t) else {
            self.blank = true;
            self.playing = None;
            self.shown = None;
            return;
        };
        self.blank = false;
        let source = clip.source_time(t);
        let (width, height) = decode_size(project);
        if playing && media.kind == MediaKind::Video {
            let restart = match &self.playing {
                Some(p) => p.clip_id != clip.id || (source - p.shown).abs() > 0.75,
                None => true,
            };
            if restart {
                let preloaded = self.next.take().filter(|next| next.clip_id == clip.id && (source - next.shown).abs() <= 0.75);
                self.playing = Some(preloaded.unwrap_or_else(|| Playing::start(project, clip, media, source)));
            }
            let half_frame = 0.5 / project.fps as f64;
            let mut latest = None;
            if let Some(p) = &mut self.playing {
                loop {
                    let frame = match p.ahead.take().or_else(|| p.stream.frames.try_recv().ok()) {
                        Some(frame) => frame,
                        None => break,
                    };
                    if frame.time <= source + half_frame {
                        p.shown = frame.time;
                        latest = Some(frame);
                    } else {
                        p.ahead = Some(frame);
                        break;
                    }
                }
            }
            if let Some(frame) = latest {
                self.show(ctx, &frame);
                self.shown = None;
            }
            return;
        }
        self.playing = None;
        let frame_number = if media.kind == MediaKind::Image { 0 } else { (source * project.fps as f64).round() as i64 };
        let key: StillKey = (media.id.clone(), frame_number);
        if self.shown.as_ref() != Some(&key) && self.waiting.is_none() {
            let at = if media.kind == MediaKind::Image { 0.0 } else { frame_number as f64 / project.fps as f64 };
            worker.send(Job::Still { key: key.clone(), path: media.path.clone(), at, width, height });
            self.waiting = Some(key);
        }
    }

    /// Starts decoding the clip that comes in front next, if that happens within `PRELOAD` seconds.
    fn preload(&mut self, project: &Project, t: f64) {
        let current = project.front_clip(t).map(|(clip, _)| clip.id.clone());
        // What's in front changes only where a video clip starts or ends.
        let mut changes: Vec<f64> = project.tracks.iter()
            .filter(|track| track.kind == TrackKind::Video)
            .flat_map(|track| track.clips.iter().flat_map(|clip| [clip.start, clip.end()]))
            .filter(|&at| at > t && at <= t + PRELOAD)
            .collect();
        changes.sort_by(f64::total_cmp);
        let upcoming = changes.into_iter().find_map(|at| {
            project.front_clip(at).filter(|(clip, _)| Some(&clip.id) != current.as_ref()).map(|(clip, media)| (at, clip, media))
        });
        let Some((at, clip, media)) = upcoming else { return };
        if media.kind != MediaKind::Video || self.next.as_ref().is_some_and(|next| next.clip_id == clip.id) {
            return;
        }
        self.next = Some(Playing::start(project, clip, media, clip.source_time(at)));
    }

    /// Forgets the picture so the next update fetches it again (after the project's shape changes).
    pub fn reset(&mut self) {
        self.shown = None;
        self.playing = None;
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
        Self { playing: false, from: 0.0, since: Instant::now() }
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
