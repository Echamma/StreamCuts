//! Slow work (probing files, thumbnails, preview stills, waveforms) runs on background threads; results come back on
//! a channel the editor drains every frame.

use crate::ffmpeg::{self, Frame};
use crate::filmstrip::{self, Film};
use crate::transcribe;
use crate::project::{Caption, Media, Picture};
use crate::waveform::{self, Waveform};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

/// Which picture a still is: media id with its framing, and frame number.
pub type StillKey = (String, i64);

pub enum Job {
    Probe(PathBuf),
    Thumbnail { media_id: String, path: PathBuf, at: f64 },
    Still { key: StillKey, path: PathBuf, at: f64, width: u32, height: u32, picture: Picture },
    /// Waveforms and filmstrips are cached in `cache`.
    Waveform { media_id: String, path: PathBuf, cache: PathBuf },
    Filmstrip { media_id: String, path: PathBuf, duration: f64, cache: PathBuf },
    /// Captions for `length` source seconds of `path` from `from`, for a clip at `speed` that starts at `at`.
    Transcribe { clip: String, path: PathBuf, from: f64, length: f64, speed: f64, at: f64 },
}

pub enum Done {
    Probed(PathBuf, Result<Media, String>),
    Thumbnail(String, Result<Frame, String>),
    Still(StillKey, Result<Frame, String>),
    Waveform(String, Result<Waveform, String>),
    Filmstrip(String, Result<Film, String>),
    /// Captions for the timeline stretch `from`..`to`.
    Captions { from: f64, to: f64, result: Result<Vec<Caption>, String> },
}

pub struct Worker {
    jobs: Sender<Job>,
    stills: Sender<Job>,
    pub done: Receiver<Done>,
}

impl Worker {
    pub fn new(ctx: egui::Context) -> Self {
        let (jobs, queue) = channel::<Job>();
        let (stills, still_queue) = channel::<Job>();
        let (finished, done) = channel();
        // One decoder handles exact preview frames. While it works, keep only the latest requested frame;
        // scrubbing across a long timeline must not queue every intermediate FFmpeg process.
        let (still_finished, still_ctx) = (finished.clone(), ctx.clone());
        std::thread::spawn(move || {
            while let Ok(mut job) = still_queue.recv() {
                while let Ok(newer) = still_queue.try_recv() { job = newer; }
                let Job::Still { key, path, at, width, height, picture } = job else { continue };
                let result = Done::Still(key, ffmpeg::still(&path, at, width, height, picture));
                if still_finished.send(result).is_err() { break; }
                still_ctx.request_repaint();
            }
        });
        let queue = Arc::new(Mutex::new(queue));
        for _ in 0..3 {
            let (queue, finished, ctx) = (queue.clone(), finished.clone(), ctx.clone());
            std::thread::spawn(move || {
                loop {
                    let job = match queue.lock().map(|q| q.recv()) {
                        Ok(Ok(job)) => job,
                        _ => break,
                    };
                    let result = match job {
                        Job::Probe(path) => Done::Probed(path.clone(), ffmpeg::probe(&path)),
                        Job::Thumbnail { media_id, path, at } => Done::Thumbnail(media_id, ffmpeg::thumbnail(&path, at)),
                        Job::Still { .. } => continue,
                        // Reading a long file through takes a while: it gets a thread of its own, so stills don't wait.
                        Job::Waveform { media_id, path, cache } => {
                            aside(&finished, &ctx, move || Done::Waveform(media_id, waveform::cached(&path, &cache)));
                            continue;
                        }
                        Job::Filmstrip { media_id, path, duration, cache } => {
                            aside(&finished, &ctx, move || Done::Filmstrip(media_id, filmstrip::cached(&path, duration, &cache)));
                            continue;
                        }
                        Job::Transcribe { clip, path, from, length, speed, at } => {
                            aside(&finished, &ctx, move || Done::Captions { from: at, to: at + length / speed, result: transcribe::captions(&clip, &path, from, length, speed, at) });
                            continue;
                        }
                    };
                    if finished.send(result).is_err() {
                        break;
                    }
                    ctx.request_repaint();
                }
            });
        }
        Self { jobs, stills, done }
    }

    pub fn send(&self, job: Job) {
        match job {
            job @ Job::Still { .. } => { let _ = self.stills.send(job); }
            job => { let _ = self.jobs.send(job); }
        }
    }
}

/// Runs a long job on a thread of its own and sends back what it makes.
fn aside(finished: &Sender<Done>, ctx: &egui::Context, job: impl FnOnce() -> Done + Send + 'static) {
    let (finished, ctx) = (finished.clone(), ctx.clone());
    std::thread::spawn(move || {
        if finished.send(job()).is_ok() {
            ctx.request_repaint();
        }
    });
}
