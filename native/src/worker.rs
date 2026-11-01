//! Slow work (probing files, thumbnails, preview stills, waveforms) runs on background threads; results come back on
//! a channel the editor drains every frame.

use crate::ffmpeg::{self, Frame};
use crate::project::Media;
use crate::waveform::{self, Waveform};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

/// Which picture a still is: media id and frame number.
pub type StillKey = (String, i64);

pub enum Job {
    Probe(PathBuf),
    Thumbnail { media_id: String, path: PathBuf, at: f64 },
    Still { key: StillKey, path: PathBuf, at: f64, width: u32, height: u32 },
    Waveform { media_id: String, path: PathBuf },
}

pub enum Done {
    Probed(PathBuf, Result<Media, String>),
    Thumbnail(String, Result<Frame, String>),
    Still(StillKey, Result<Frame, String>),
    Waveform(String, Result<Waveform, String>),
}

pub struct Worker {
    jobs: Sender<Job>,
    pub done: Receiver<Done>,
}

impl Worker {
    pub fn new(ctx: egui::Context) -> Self {
        let (jobs, queue) = channel::<Job>();
        let (finished, done) = channel();
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
                        Job::Still { key, path, at, width, height } => Done::Still(key, ffmpeg::still(&path, at, width, height)),
                        // Reading a long file's sound takes a while: it gets a thread of its own, so stills don't wait.
                        Job::Waveform { media_id, path } => {
                            let (finished, ctx) = (finished.clone(), ctx.clone());
                            std::thread::spawn(move || {
                                if finished.send(Done::Waveform(media_id, waveform::decode(&path))).is_ok() {
                                    ctx.request_repaint();
                                }
                            });
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
        Self { jobs, done }
    }

    pub fn send(&self, job: Job) {
        let _ = self.jobs.send(job);
    }
}
