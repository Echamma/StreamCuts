//! FFmpeg and FFprobe run as child processes: StreamCuts probes, decodes and exports through them, with nothing linked.

use crate::project::{Framing, Media, MediaKind, Picture, new_id};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

fn find(name: &str, env: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env).map(PathBuf::from).filter(|p| p.is_file()) {
        return path;
    }
    let exe = format!("{name}.exe");
    let found: Vec<PathBuf> = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|dir| dir.join(&exe))
        .filter(|candidate| candidate.is_file())
        .collect();
    // A static build (one 240 MB exe) takes about half a second just to start on Windows; a shared build (a small exe
    // and DLLs) takes a few dozen milliseconds. StreamCuts starts FFmpeg for every still, so when PATH has both, use
    // the shared one.
    found.iter().find(|path| is_shared_build(path)).or(found.first()).cloned().unwrap_or_else(|| PathBuf::from(name))
}

fn is_shared_build(exe: &Path) -> bool {
    let Some(entries) = exe.parent().and_then(|dir| std::fs::read_dir(dir).ok()) else { return false };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        name.starts_with("avcodec-") && name.ends_with(".dll")
    })
}

/// `STREAMCUTS_FFMPEG`, else `ffmpeg` on PATH.
pub fn ffmpeg() -> PathBuf {
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    FOUND.get_or_init(|| find("ffmpeg", "STREAMCUTS_FFMPEG")).clone()
}

/// `STREAMCUTS_FFPROBE`, else `ffprobe` on PATH.
pub fn ffprobe() -> PathBuf {
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    FOUND.get_or_init(|| find("ffprobe", "STREAMCUTS_FFPROBE")).clone()
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
        return Ok(Media { id: new_id(), path: path.to_path_buf(), name, kind: MediaKind::Image, duration: 0.0, width, height, has_audio: false, frame_rate: 0.0 });
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
            // "30000/1001" and the like.
            frame_rate: v["avg_frame_rate"].as_str().or(v["r_frame_rate"].as_str()).and_then(|rate| {
                let (n, d) = rate.split_once('/')?;
                let (n, d) = (n.parse::<f64>().ok()?, d.parse::<f64>().ok()?);
                (d > 0.0).then(|| n / d)
            }).unwrap_or(0.0),
        }),
        None if has_audio => Ok(Media { id: new_id(), path: path.to_path_buf(), name, kind: MediaKind::Audio, duration, width: 0, height: 0, has_audio, frame_rate: 0.0 }),
        None => Err(format!("{name} has no picture or sound StreamCuts can use.")),
    }
}

/// Where the picture cuts to another scene, in source seconds: FFmpeg's scene score above `threshold` (0-1; the web
/// StreamCuts uses 0.3). Reads the whole file at a small size; call it off the UI thread.
pub fn scenes(path: &Path, threshold: f64) -> Result<Vec<f64>, String> {
    let output = command(&ffmpeg())
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(path)
        .args(["-an", "-vf", &format!("scale=160:-2,select='gt(scene,{threshold})',showinfo"), "-f", "null", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    if !output.status.success() {
        return Err("FFmpeg couldn't read this file for scenes.".into());
    }
    // showinfo prints a line per selected frame: "... pts_time:12.345 ...".
    Ok(String::from_utf8_lossy(&output.stderr).lines().filter(|line| line.contains("Parsed_showinfo"))
        .filter_map(|line| line.split("pts_time:").nth(1)?.split_whitespace().next()?.parse::<f64>().ok())
        .collect())
}

/// One decoded picture, RGBA, at a source time.
pub struct Frame {
    pub time: f64,
    pub size: [usize; 2],
    pub rgba: Vec<u8>,
}

/// The incoming picture fades over the outgoing one at a cut. Both are decoded to the project size.
pub fn blend_frames(outgoing: &Frame, incoming: &Frame, progress: f32) -> Frame {
    let progress = progress.clamp(0.0, 1.0);
    let mut rgba = incoming.rgba.clone();
    if outgoing.size == incoming.size {
        for (to, from) in rgba.chunks_exact_mut(4).zip(outgoing.rgba.chunks_exact(4)) {
            for channel in 0..3 {
                to[channel] = (from[channel] as f32 * (1.0 - progress) + to[channel] as f32 * progress).round() as u8;
            }
        }
    }
    Frame { time: incoming.time, size: incoming.size, rgba }
}

/// The `-ss` for the frame at `at`. FFmpeg starts at the first frame at or after the time it's given, and a frame's
/// time rounded to milliseconds can land just after it (14/30 s is 0.46667: "0.467" would give frame 15), so this
/// asks for a millisecond early.
fn seek_to(at: f64) -> String {
    format!("{:.3}", (at - 0.001).max(0.0))
}

/// FFmpeg's `atempo` for a speed: one step only goes from 0.5 to 2, so bigger changes chain several.
pub fn atempo(speed: f64) -> Option<String> {
    if (speed - 1.0).abs() < 1e-6 {
        return None;
    }
    let (mut left, mut steps) = (speed, Vec::new());
    while left > 2.0 {
        steps.push("atempo=2".to_string());
        left /= 2.0;
    }
    while left < 0.5 {
        steps.push("atempo=0.5".to_string());
        left /= 0.5;
    }
    steps.push(format!("atempo={left:.4}"));
    Some(steps.join(","))
}

pub(crate) fn scale_filter(width: u32, height: u32) -> String {
    Framing::Fit.filter(width, height)
}

/// One frame at `at` seconds, shown as `picture` in `width`×`height`. Blocking: call it off the UI thread.
pub fn still(path: &Path, at: f64, width: u32, height: u32, picture: Picture) -> Result<Frame, String> {
    // Pictures are read directly unless they have a color grade, which FFmpeg applies exactly as exports do.
    if is_image(path) && picture.grade.is_neutral() && picture.effects.is_neutral() {
        let framing = picture.framing;
        let image = image::open(path).map_err(|e| e.to_string())?;
        let (iw, ih) = (image.width().max(1) as f32, image.height().max(1) as f32);
        // Scale to fit (or fill), then place the picture: centered with bars, or cropped around the focus.
        let (scale, focus) = match framing {
            Framing::Fit => ((width as f32 / iw).min(height as f32 / ih), (0.5, 0.5)),
            Framing::Fill { x, y } => ((width as f32 / iw).max(height as f32 / ih), (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0))),
        };
        let (sw, sh) = (((iw * scale).round() as u32).max(1), ((ih * scale).round() as u32).max(1));
        let scaled = image.resize_exact(sw, sh, image::imageops::FilterType::Triangle).to_rgba8();
        let mut canvas = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 255]));
        let x = ((width as f32 - sw as f32) * focus.0).round() as i64;
        let y = ((height as f32 - sh as f32) * focus.1).round() as i64;
        image::imageops::overlay(&mut canvas, &scaled, x, y);
        return Ok(Frame { time: at, size: [width as usize, height as usize], rgba: canvas.into_raw() });
    }
    let output = command(&ffmpeg())
        .args(["-v", "error", "-ss", &seek_to(at)])
        .arg("-i")
        .arg(path)
        .args(["-frames:v", "1", "-an", "-vf", &picture.filter(width, height), "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"])
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
    still(path, at, 192, 108, Picture::default())
}

/// FFmpeg started on a thread of its own, reading its output there: a static build can take half a second to start,
/// and the editor mustn't stop for it. Dropping this stops FFmpeg, whether it has got going yet or not.
struct Background {
    state: Arc<Mutex<Started>>,
}

enum Started {
    Pending,
    Running(Child),
    Stopped,
}

impl Background {
    /// Starts `command` and runs `read` on its output, sending what it reads to the returned receiver.
    fn start<T: Send + 'static>(
        mut command: Command,
        capacity: usize,
        read: impl FnOnce(ChildStdout, SyncSender<T>) + Send + 'static,
    ) -> (Self, Receiver<T>) {
        let state = Arc::new(Mutex::new(Started::Pending));
        let (sender, receiver) = sync_channel(capacity);
        let shared = state.clone();
        std::thread::spawn(move || {
            let Ok(mut child) = command.stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return };
            let stdout = child.stdout.take().expect("piped");
            {
                let mut state = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if matches!(*state, Started::Stopped) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                *state = Started::Running(child);
            }
            read(stdout, sender);
        });
        (Self { state }, receiver)
    }
}

impl Drop for Background {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Started::Running(mut child) = std::mem::replace(&mut *state, Started::Stopped) {
            let _ = child.kill();
            // Waiting for the process to go can take a moment; it needn't hold up the caller.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

/// Frames decoded continuously from a source time onwards, for playback. Dropping it stops FFmpeg.
pub struct FrameStream {
    _ffmpeg: Background,
    pub frames: Receiver<Frame>,
    pub from: f64,
}

impl FrameStream {
    /// `speed` plays the source faster or slower; frame times stay in source seconds.
    pub fn start(path: &Path, from: f64, fps: u32, width: u32, height: u32, picture: Picture, speed: f64) -> Self {
        // Start on a frame, so each frame's time is exactly the source time it shows.
        let from = (from * fps as f64 - 1e-6).ceil().max(0.0) / fps as f64;
        let mut command = command(&ffmpeg());
        command
            .args(["-v", "error", "-ss", &seek_to(from)])
            .arg("-i")
            .arg(path)
            .args(["-an", "-vf", &format!("setpts=(PTS-STARTPTS)/{speed:.4},fps={fps},{}", picture.filter(width, height)), "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]);
        let frame_bytes = (width * height * 4) as usize;
        let (ffmpeg, frames) = Background::start(command, 6, move |mut stdout, sender| {
            for index in 0.. {
                let mut rgba = vec![0u8; frame_bytes];
                if stdout.read_exact(&mut rgba).is_err() {
                    break;
                }
                let frame = Frame { time: from + index as f64 * speed / fps as f64, size: [width as usize, height as usize], rgba };
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        Self { _ffmpeg: ffmpeg, frames, from }
    }
}

/// Sound decoded from a source time for `length` seconds of playback at `speed`, as interleaved f32 samples at the
/// output's rate and channel count. Dropping it stops FFmpeg.
pub struct SoundStream {
    _ffmpeg: Background,
    pub chunks: Receiver<Vec<f32>>,
}

impl SoundStream {
    pub fn start(path: &Path, from: f64, length: f64, speed: f64, rate: u32, channels: u16) -> Self {
        let mut command = command(&ffmpeg());
        command
            .args(["-v", "error", "-ss", &format!("{from:.3}")])
            .arg("-i")
            .arg(path)
            .args(["-t", &format!("{:.3}", length * speed), "-vn"]);
        if let Some(tempo) = atempo(speed) {
            command.args(["-af", &tempo]);
        }
        command.args(["-ac", &channels.to_string(), "-ar", &rate.to_string(), "-f", "f32le", "pipe:1"]);
        let (ffmpeg, chunks) = Background::start(command, 32, |mut stdout, sender| {
            let mut bytes = vec![0u8; 4096 * 4];
            // A read can end partway through a sample: those bytes wait at the front for the rest.
            let mut filled = 0;
            loop {
                match stdout.read(&mut bytes[filled..]) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        filled += read;
                        let whole = filled - filled % 4;
                        let samples: Vec<f32> = bytes[..whole].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                        bytes.copy_within(whole..filled, 0);
                        filled -= whole;
                        if !samples.is_empty() && sender.send(samples).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Self { _ffmpeg: ffmpeg, chunks }
    }

    /// Hands the samples to whoever plays them (the output thread) while FFmpeg's lifetime stays with this.
    pub fn take_chunks(&mut self) -> Receiver<Vec<f32>> {
        std::mem::replace(&mut self.chunks, sync_channel(0).1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_speed_changes_chain_atempo() {
        assert_eq!(atempo(1.0), None);
        assert_eq!(atempo(1.5).as_deref(), Some("atempo=1.5000"));
        assert_eq!(atempo(4.0).as_deref(), Some("atempo=2,atempo=2.0000"));
        assert_eq!(atempo(0.25).as_deref(), Some("atempo=0.5,atempo=0.5000"));
    }

    /// Needs FFmpeg on PATH: makes a 2-second clip with sound, then reads it back.
    #[test]
    fn probes_and_decodes_a_generated_clip() {
        let dir = std::env::temp_dir().join(format!("streamcuts-ffmpeg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let made = command(&ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(made.success());
        let media = probe(&clip).unwrap();
        assert!((media.frame_rate - 30.0).abs() < 0.01, "frame rate {}", media.frame_rate);
        assert!(media.info().starts_with("Video · 320×180 · 30 fps · 0:00:02 · with sound · "), "{}", media.info());
        assert_eq!(media.kind, MediaKind::Video);
        assert!((media.duration - 2.0).abs() < 0.1, "duration {}", media.duration);
        assert!(media.has_audio && media.width == 320 && media.height == 180);
        let frame = still(&clip, 1.0, 160, 90, Picture::default()).unwrap();
        // The generated clip is one continuous test pattern: no cuts.
        assert!(scenes(&clip, 0.3).unwrap().is_empty());
        assert_eq!(frame.rgba.len(), 160 * 90 * 4);
        // A grade with no saturation leaves gray: red, green and blue alike in every pixel.
        let gray = Picture { grade: crate::project::Grade { saturation: 0.0, ..Default::default() }, ..Default::default() };
        let graded = still(&clip, 1.0, 160, 90, gray).unwrap();
        let spread = graded.rgba.chunks(4).map(|p| p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2])).max().unwrap();
        assert!(spread <= 6, "colors left in a gray picture: {spread}");
        let soft = Picture { effects: crate::project::Effects { blur: 4.0, sharpen: 0.0, look: None }, ..Default::default() };
        let blurred = still(&clip, 1.0, 160, 90, soft).unwrap();
        assert_ne!(blurred.rgba, frame.rgba, "blur should change the decoded picture");
        // The negative look inverts the picture, through the same filter exports use.
        let negative = Picture { effects: crate::project::Effects { look: Some(crate::project::Look::Negative), ..Default::default() }, ..Default::default() };
        let inverted = still(&clip, 1.0, 160, 90, negative).unwrap();
        let (a, b) = (&frame.rgba[4 * 4000..][..3], &inverted.rgba[4 * 4000..][..3]);
        assert!(a.iter().zip(b).all(|(x, y)| (*x as i32 + *y as i32 - 255).abs() < 12), "{a:?} vs {b:?}");
        let crisp = Picture { effects: crate::project::Effects { blur: 0.0, sharpen: 1.0, look: None }, ..Default::default() };
        let sharpened = still(&clip, 1.0, 160, 90, crisp).unwrap();
        assert_ne!(sharpened.rgba, frame.rgba, "sharpen should change the decoded picture");
        // Streamed frames carry their real source time: each looks like the still at its time, not its neighbors'.
        let stream = FrameStream::start(&clip, 0.5, 30, 160, 90, Picture::default(), 1.0);
        let frames: Vec<Frame> = stream.frames.iter().take(16).collect();
        assert!((frames[0].time - 0.5).abs() < 1e-9 && frames[0].rgba.len() == 160 * 90 * 4);
        for frame in [&frames[0], &frames[15]] {
            let unlike = |t: f64| {
                let other = still(&clip, t, 160, 90, Picture::default()).unwrap();
                frame.rgba.iter().zip(&other.rgba).map(|(a, b)| a.abs_diff(*b) as u64).sum::<u64>()
            };
            let (here, before, after) = (unlike(frame.time), unlike(frame.time - 1.0 / 30.0), unlike(frame.time + 1.0 / 30.0));
            assert!(here < before && here < after, "frame at {:.3}: {here} vs {before} before, {after} after", frame.time);
        }
        drop(stream);
        // 1.5 s of stereo at 48 kHz from 0.25 s in, give or take a packet.
        let mut sound = SoundStream::start(&clip, 0.25, 1.5, 1.0, 48_000, 2);
        let samples: usize = sound.take_chunks().iter().map(|chunk| chunk.len()).sum();
        assert!(samples % 2 == 0 && (samples as i64 - 144_000).abs() < 4_000, "{samples} samples");
        drop(sound);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

