//! FFmpeg and FFprobe run as child processes: StreamCuts probes, decodes and exports through them, with nothing linked.

use crate::project::{Media, MediaKind, new_id};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

fn find(name: &str, env: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env).map(PathBuf::from).filter(|p| p.is_file()) {
        return path;
    }
    let exe = format!("{name}.exe");
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|dir| dir.join(&exe))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// `STREAMCUTS_FFMPEG`, else `ffmpeg` on PATH.
pub fn ffmpeg() -> PathBuf {
    find("ffmpeg", "STREAMCUTS_FFMPEG")
}

/// `STREAMCUTS_FFPROBE`, else `ffprobe` on PATH.
pub fn ffprobe() -> PathBuf {
    find("ffprobe", "STREAMCUTS_FFPROBE")
}

/// A command that never flashes a console window.
pub fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.stdin(Stdio::null());
    command
}

fn is_image(path: &Path) -> bool {
    path.extension().map(|e| IMAGE_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str())).unwrap_or(false)
}

/// Reads what a media file holds (length, size, sound) into a [`Media`] the project can use.
pub fn probe(path: &Path) -> Result<Media, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if is_image(path) {
        let (width, height) = image::image_dimensions(path).map_err(|e| format!("{name} couldn't be read: {e}"))?;
        return Ok(Media { id: new_id(), path: path.to_path_buf(), name, kind: MediaKind::Image, duration: 0.0, width, height, has_audio: false });
    }
    let output = command(&ffprobe())
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("FFprobe couldn't start ({e}). Install FFmpeg or set STREAMCUTS_FFPROBE."))?;
    if !output.status.success() {
        return Err(format!("{name} isn't a video or sound file StreamCuts can read."));
    }
    let info: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let streams = info["streams"].as_array().cloned().unwrap_or_default();
    // Cover art in audio files shows up as a one-frame video stream; it doesn't make the file a video.
    let video = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let duration = info["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
    match video {
        Some(v) => Ok(Media {
            id: new_id(),
            path: path.to_path_buf(),
            name,
            kind: MediaKind::Video,
            duration,
            width: v["width"].as_u64().unwrap_or(0) as u32,
            height: v["height"].as_u64().unwrap_or(0) as u32,
            has_audio,
        }),
        None if has_audio => Ok(Media { id: new_id(), path: path.to_path_buf(), name, kind: MediaKind::Audio, duration, width: 0, height: 0, has_audio }),
        None => Err(format!("{name} has no picture or sound StreamCuts can use.")),
    }
}

/// One decoded picture, RGBA, at a source time.
pub struct Frame {
    pub time: f64,
    pub size: [usize; 2],
    pub rgba: Vec<u8>,
}

fn scale_filter(width: u32, height: u32) -> String {
    format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black")
}

/// One frame at `at` seconds, letterboxed into `width`×`height`. Blocking: call it off the UI thread.
pub fn still(path: &Path, at: f64, width: u32, height: u32) -> Result<Frame, String> {
    if is_image(path) {
        let image = image::open(path).map_err(|e| e.to_string())?;
        let fitted = image.resize(width, height, image::imageops::FilterType::Triangle).to_rgba8();
        let mut canvas = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 255]));
        let (x, y) = ((width - fitted.width()) / 2, (height - fitted.height()) / 2);
        image::imageops::overlay(&mut canvas, &fitted, x as i64, y as i64);
        return Ok(Frame { time: at, size: [width as usize, height as usize], rgba: canvas.into_raw() });
    }
    let output = command(&ffmpeg())
        .args(["-v", "error", "-ss", &format!("{at:.3}")])
        .arg("-i")
        .arg(path)
        .args(["-frames:v", "1", "-an", "-vf", &scale_filter(width, height), "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"])
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    let expected = (width * height * 4) as usize;
    if output.stdout.len() < expected {
        return Err("No picture at that time.".into());
    }
    Ok(Frame { time: at, size: [width as usize, height as usize], rgba: output.stdout[..expected].to_vec() })
}

/// A small PNG-sized thumbnail for the media bin and clips.
pub fn thumbnail(path: &Path, at: f64) -> Result<Frame, String> {
    still(path, at, 192, 108)
}

/// Frames decoded continuously from a source time onwards, for playback. Dropping it stops FFmpeg.
pub struct FrameStream {
    child: Child,
    pub frames: Receiver<Frame>,
    pub from: f64,
}

impl FrameStream {
    pub fn start(path: &Path, from: f64, fps: u32, width: u32, height: u32) -> Result<Self, String> {
        let mut child = command(&ffmpeg())
            .args(["-v", "error", "-ss", &format!("{from:.3}")])
            .arg("-i")
            .arg(path)
            .args(["-an", "-vf", &format!("fps={fps},{}", scale_filter(width, height)), "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
        let mut stdout = child.stdout.take().expect("piped");
        let (sender, frames): (SyncSender<Frame>, Receiver<Frame>) = sync_channel(6);
        let frame_bytes = (width * height * 4) as usize;
        std::thread::spawn(move || {
            for index in 0.. {
                let mut rgba = vec![0u8; frame_bytes];
                if stdout.read_exact(&mut rgba).is_err() {
                    break;
                }
                let frame = Frame { time: from + index as f64 / fps as f64, size: [width as usize, height as usize], rgba };
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        Ok(Self { child, frames, from })
    }
}

impl Drop for FrameStream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Sound decoded from a source time onwards as interleaved f32 samples at the output's rate and channel count.
pub struct SoundStream {
    child: Child,
    pub chunks: Receiver<Vec<f32>>,
}

impl SoundStream {
    pub fn start(path: &Path, from: f64, rate: u32, channels: u16) -> Result<Self, String> {
        let mut child = command(&ffmpeg())
            .args(["-v", "error", "-ss", &format!("{from:.3}")])
            .arg("-i")
            .arg(path)
            .args(["-vn", "-ac", &channels.to_string(), "-ar", &rate.to_string(), "-f", "f32le", "pipe:1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
        let mut stdout = child.stdout.take().expect("piped");
        let (sender, chunks) = sync_channel(32);
        std::thread::spawn(move || {
            let mut bytes = vec![0u8; 4096 * 4];
            loop {
                match stdout.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let read = read - read % 4;
                        let samples: Vec<f32> = bytes[..read].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                        if sender.send(samples).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self { child, chunks })
    }
}

impl Drop for SoundStream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
