//! FFmpeg and FFprobe run as child processes: StreamCuts probes, decodes and exports through them, with nothing linked.

use crate::project::{BLUR_THROUGH, Framing, Media, MediaKind, Picture, Transition, new_id};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex, OnceLock};

const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

fn find(name: &str, env: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
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
    found
        .iter()
        .find(|path| is_shared_build(path))
        .or(found.first())
        .cloned()
        .unwrap_or_else(|| PathBuf::from(name))
}

fn is_shared_build(exe: &Path) -> bool {
    let Some(entries) = exe.parent().and_then(|dir| std::fs::read_dir(dir).ok()) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        name.starts_with("avcodec-") && name.ends_with(".dll")
    })
}

/// `STREAMCUTS_FFMPEG`, else `ffmpeg` on PATH.
pub fn ffmpeg() -> PathBuf {
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    FOUND
        .get_or_init(|| find("ffmpeg", "STREAMCUTS_FFMPEG"))
        .clone()
}

/// `STREAMCUTS_FFPROBE`, else `ffprobe` on PATH.
pub fn ffprobe() -> PathBuf {
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    FOUND
        .get_or_init(|| find("ffprobe", "STREAMCUTS_FFPROBE"))
        .clone()
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
    path.extension()
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn is_gif(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("gif"))
}

/// A stream's frame rate from FFprobe: "30000/1001" and the like.
fn frame_rate(stream: &serde_json::Value) -> f64 {
    stream["avg_frame_rate"]
        .as_str()
        .or(stream["r_frame_rate"].as_str())
        .and_then(|rate| {
            let (n, d) = rate.split_once('/')?;
            let (n, d) = (n.parse::<f64>().ok()?, d.parse::<f64>().ok()?);
            (d > 0.0).then(|| n / d)
        })
        .unwrap_or(0.0)
}

/// How long an animated GIF takes to play once, and its frame rate. `None` for a GIF of one frame, or one FFprobe
/// can't read: that's a still picture.
pub fn gif_loop(path: &Path) -> Option<(f64, f64)> {
    let output = command(&ffprobe())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=nb_frames,avg_frame_rate,r_frame_rate",
            "-print_format",
            "json",
        ])
        .arg(path)
        .output()
        .ok()?;
    let info: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let stream = &info["streams"][0];
    let frames = stream["nb_frames"]
        .as_str()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0);
    let duration = info["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    (frames > 1 && duration > 0.0).then(|| (duration, frame_rate(stream)))
}

/// Reads what a media file holds (length, size, sound) into a [`Media`] the project can use.
pub fn probe(path: &Path) -> Result<Media, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if is_image(path) {
        let (width, height) =
            image::image_dimensions(path).map_err(|e| format!("{name} couldn't be read: {e}"))?;
        // An animated GIF keeps the length of one play-through: its clips loop it (`Media::loop_length`).
        let (duration, frame_rate) = if is_gif(path) {
            gif_loop(path).unwrap_or_default()
        } else {
            (0.0, 0.0)
        };
        return Ok(Media {
            id: new_id(),
            path: path.to_path_buf(),
            name,
            kind: MediaKind::Image,
            duration,
            width,
            height,
            has_audio: false,
            frame_rate,
            attributes: Default::default(),
        });
    }
    let output = command(&ffprobe())
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|e| {
            format!("FFprobe couldn't start ({e}). Install FFmpeg or set STREAMCUTS_FFPROBE.")
        })?;
    if !output.status.success() {
        return Err(format!(
            "{name} isn't a video or sound file StreamCuts can read."
        ));
    }
    let info: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let streams = info["streams"].as_array().cloned().unwrap_or_default();
    // Cover art in audio files shows up as a one-frame video stream; it doesn't make the file a video.
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let duration = info["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
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
            frame_rate: frame_rate(v),
            attributes: Default::default(),
        }),
        None if has_audio => Ok(Media {
            id: new_id(),
            path: path.to_path_buf(),
            name,
            kind: MediaKind::Audio,
            duration,
            width: 0,
            height: 0,
            has_audio,
            frame_rate: 0.0,
            attributes: Default::default(),
        }),
        None => Err(format!(
            "{name} has no picture or sound StreamCuts can use."
        )),
    }
}

/// A stretch of a file's integrated loudness (EBU R128), in LUFS. Reads the whole stretch; call it off the UI thread.
pub fn loudness(path: &Path, from: f64, length: f64) -> Result<f64, String> {
    let output = command(&ffmpeg())
        .args([
            "-hide_banner",
            "-nostats",
            "-ss",
            &format!("{:.3}", seek_to(from)),
            "-t",
            &format!("{length:.3}"),
            "-i",
        ])
        .arg(path)
        .args(["-vn", "-af", "ebur128", "-f", "null", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    // The summary at the end: "Integrated loudness:\n    I:         -23.0 LUFS".
    let text = String::from_utf8_lossy(&output.stderr);
    let summary = text
        .rsplit("Integrated loudness:")
        .next()
        .filter(|_| text.contains("Integrated loudness:"))
        .ok_or("This clip has no sound to measure.")?;
    summary
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("I:")?
                .trim()
                .strip_suffix("LUFS")?
                .trim()
                .parse::<f64>()
                .ok()
        })
        .ok_or_else(|| "FFmpeg didn't report the loudness.".into())
}

/// Makes an editing proxy of a video at `output`, for smooth playback (the web StreamCuts' H.264 proxy): its picture
/// at most 540 lines tall, H.264 with a keyframe every 15 frames so playback starts quickly anywhere, and no sound
/// (playback reads sound from the original). It appears at `output` only once it's whole. Reads the whole file; call
/// it off the UI thread.
pub fn proxy(path: &Path, output: &Path) -> Result<(), String> {
    if let Some(dir) = output.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't make the proxy folder ({e})."))?;
    }
    let partial = output.with_extension("partial.mp4");
    let result = command(&ffmpeg())
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-vf",
            "scale=-2:'min(540,ih)'",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "26",
        ])
        .args(["-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
        .arg(&partial)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!(
            "FFmpeg couldn't make a proxy: {}",
            String::from_utf8_lossy(&result.stderr)
                .lines()
                .last()
                .unwrap_or("no reason given")
        ));
    }
    std::fs::rename(&partial, output).map_err(|e| format!("Couldn't keep the proxy ({e})."))
}

/// Where the action is in a stretch of a video, as the web StreamCuts' auto-reframe finds it: four frames a second at
/// a small size, and in each the cell of an 8x8 grid that changed most since the frame before (held where nothing
/// much moves), eased over half a second. Returns points at source times, few enough for a crop expression. Reads the
/// whole stretch (streaming it); call it off the UI thread.
pub fn focus(path: &Path, from: f64, length: f64) -> Result<Vec<crate::project::Focus>, String> {
    const RATE: f64 = 4.0;
    let (width, height) = (160usize, 90usize);
    let mut child = command(&ffmpeg())
        .args([
            "-v",
            "error",
            "-ss",
            &seek_to(from),
            "-t",
            &format!("{length:.3}"),
            "-i",
        ])
        .arg(path)
        .args([
            "-an",
            "-vf",
            &format!("fps={RATE},scale={width}:{height}"),
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    let mut stdout = child.stdout.take().ok_or("FFmpeg gave no picture.")?;
    let mut motion = Motion::new(width, height, RATE);
    let mut track = Vec::new();
    let mut frame = vec![0u8; width * height];
    while stdout.read_exact(&mut frame).is_ok() {
        let (x, y) = motion.next(&frame);
        track.push(crate::project::Focus {
            t: from + track.len() as f64 / RATE,
            x,
            y,
        });
    }
    let _ = child.wait();
    if track.is_empty() {
        return Err("FFmpeg read no frames to follow.".into());
    }
    Ok(crate::project::simplify_track(&track, 0.03, 40))
}

/// The web StreamCuts' motion-energy saliency (its `saliency` crate), frame by frame.
struct Motion {
    size: (usize, usize),
    previous: Option<Vec<u8>>,
    /// The eased place, and how much of each new place it takes (dt / (dt + 0.5 s)).
    place: Option<(f32, f32)>,
    ease: f32,
}

impl Motion {
    const GRID: usize = 8;

    fn new(width: usize, height: usize, rate: f64) -> Self {
        let dt = 1.0 / rate as f32;
        Motion {
            size: (width, height),
            previous: None,
            place: None,
            ease: dt / (dt + 0.5),
        }
    }

    fn next(&mut self, luma: &[u8]) -> (f32, f32) {
        let (width, height) = self.size;
        let last = self.place.unwrap_or((0.5, 0.5));
        let raw = match &self.previous {
            None => last,
            Some(previous) => {
                let mut cells = [0u64; Self::GRID * Self::GRID];
                for y in 0..height {
                    for x in 0..width {
                        let i = y * width + x;
                        cells[(y * Self::GRID / height) * Self::GRID + x * Self::GRID / width] +=
                            luma[i].abs_diff(previous[i]) as u64;
                    }
                }
                // Below half a level of change per pixel it's noise, not motion: stay put.
                let total: u64 = cells.iter().sum();
                if (total as f64) < 0.5 * (width * height) as f64 {
                    last
                } else {
                    let best = (0..cells.len()).max_by_key(|&i| cells[i]).unwrap_or(0);
                    (
                        ((best % Self::GRID) as f32 + 0.5) / Self::GRID as f32,
                        ((best / Self::GRID) as f32 + 0.5) / Self::GRID as f32,
                    )
                }
            }
        };
        self.previous = Some(luma.to_vec());
        let eased = match self.place {
            None => raw,
            Some((x, y)) => (x + (raw.0 - x) * self.ease, y + (raw.1 - y) * self.ease),
        };
        self.place = Some(eased);
        eased
    }
}

/// Where the picture cuts to another scene, in source seconds: FFmpeg's scene score above `threshold` (0-1; the web
/// StreamCuts uses 0.3). Reads the whole file at a small size; call it off the UI thread.
pub fn scenes(path: &Path, threshold: f64) -> Result<Vec<f64>, String> {
    let output = command(&ffmpeg())
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(path)
        .args([
            "-an",
            "-vf",
            &format!("scale=160:-2,select='gt(scene,{threshold})',showinfo"),
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    if !output.status.success() {
        return Err("FFmpeg couldn't read this file for scenes.".into());
    }
    // showinfo prints a line per selected frame: "... pts_time:12.345 ...".
    Ok(String::from_utf8_lossy(&output.stderr)
        .lines()
        .filter(|line| line.contains("Parsed_showinfo"))
        .filter_map(|line| {
            line.split("pts_time:")
                .nth(1)?
                .split_whitespace()
                .next()?
                .parse::<f64>()
                .ok()
        })
        .collect())
}

/// One decoded picture, RGBA, at a source time.
#[derive(Clone)]
pub struct Frame {
    pub time: f64,
    pub size: [usize; 2],
    pub rgba: Vec<u8>,
}

/// The incoming picture fades over the outgoing one at a cut. Both are decoded to the project size.
/// The picture partway (`progress`, 0-1) through a crossfade, as exports draw it: a dissolve, or for a blur-through
/// each picture mixed towards a blurred copy of itself on its way out (or in) first.
pub fn crossfade_frames(
    outgoing: &Frame,
    incoming: &Frame,
    progress: f32,
    transition: Transition,
) -> Frame {
    match transition {
        Transition::Dissolve => blend_frames(outgoing, incoming, progress),
        Transition::BlurThrough => {
            let sigma = BLUR_THROUGH * incoming.size[1] as f32;
            let leaving = blend_frames(outgoing, &blurred(outgoing, sigma), progress);
            let arriving = blend_frames(incoming, &blurred(incoming, sigma), 1.0 - progress);
            blend_frames(&leaving, &arriving, progress)
        }
    }
}

/// A Gaussian-like blur of `sigma` pixels: three box blurs across and three down, so the preview blurs like FFmpeg's
/// `gblur` in exports. Alpha is left alone.
pub fn blurred(frame: &Frame, sigma: f32) -> Frame {
    let [width, height] = frame.size;
    // The box that, three times over, spreads as far as the Gaussian.
    let radius = ((((4.0 * sigma * sigma + 1.0).sqrt()) - 1.0) / 2.0)
        .round()
        .max(0.0) as usize;
    let mut rgba = frame.rgba.clone();
    if radius > 0 && width > 0 && height > 0 {
        let mut line = Vec::new();
        for _ in 0..3 {
            for y in 0..height {
                box_pass(&mut rgba, y * width * 4, 4, width, radius, &mut line);
            }
            for x in 0..width {
                box_pass(&mut rgba, x * 4, width * 4, height, radius, &mut line);
            }
        }
    }
    Frame {
        time: frame.time,
        size: frame.size,
        rgba,
    }
}

/// One box blur along a line of `count` pixels `stride` bytes apart from `start`, its end pixels repeated beyond it.
fn box_pass(
    rgba: &mut [u8],
    start: usize,
    stride: usize,
    count: usize,
    radius: usize,
    line: &mut Vec<[u32; 3]>,
) {
    line.clear();
    line.extend((0..count).map(|i| {
        let p = start + i * stride;
        [rgba[p] as u32, rgba[p + 1] as u32, rgba[p + 2] as u32]
    }));
    let at = |i: isize| line[i.clamp(0, count as isize - 1) as usize];
    let (r, width) = (radius as isize, 2 * radius as u32 + 1);
    let mut sum = (-r..=r).fold([0u32; 3], |sum, i| {
        let v = at(i);
        [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]]
    });
    for i in 0..count as isize {
        let p = start + i as usize * stride;
        for c in 0..3 {
            rgba[p + c] = ((sum[c] + width / 2) / width) as u8;
        }
        let (add, remove) = (at(i + r + 1), at(i - r));
        for c in 0..3 {
            sum[c] = sum[c] + add[c] - remove[c];
        }
    }
}

pub fn blend_frames(outgoing: &Frame, incoming: &Frame, progress: f32) -> Frame {
    let progress = progress.clamp(0.0, 1.0);
    let mut rgba = incoming.rgba.clone();
    if outgoing.size == incoming.size {
        for (to, from) in rgba.chunks_exact_mut(4).zip(outgoing.rgba.chunks_exact(4)) {
            for channel in 0..3 {
                to[channel] = (from[channel] as f32 * (1.0 - progress)
                    + to[channel] as f32 * progress)
                    .round() as u8;
            }
        }
    }
    Frame {
        time: incoming.time,
        size: incoming.size,
        rgba,
    }
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
pub fn still(
    path: &Path,
    at: f64,
    width: u32,
    height: u32,
    picture: Picture,
) -> Result<Frame, String> {
    // Pictures are read directly unless they have a color grade, which FFmpeg applies exactly as exports do. Past its
    // first frame a GIF is an animation, and FFmpeg finds the frame.
    if is_image(path)
        && !(at > 0.0 && is_gif(path))
        && picture.grade.is_neutral()
        && picture.effects.is_neutral()
    {
        let framing = picture.framing;
        let image = image::open(path).map_err(|e| e.to_string())?;
        let (iw, ih) = (image.width().max(1) as f32, image.height().max(1) as f32);
        // Scale to fit (or fill), then place the picture: centered with bars, or cropped around the focus.
        let (scale, focus) = match framing {
            Framing::Fit => ((width as f32 / iw).min(height as f32 / ih), (0.5, 0.5)),
            Framing::Fill { x, y } => (
                (width as f32 / iw).max(height as f32 / ih),
                (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)),
            ),
        };
        let (sw, sh) = (
            ((iw * scale).round() as u32).max(1),
            ((ih * scale).round() as u32).max(1),
        );
        let scaled = image
            .resize_exact(sw, sh, image::imageops::FilterType::Triangle)
            .to_rgba8();
        let mut canvas = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 255]));
        let x = ((width as f32 - sw as f32) * focus.0).round() as i64;
        let y = ((height as f32 - sh as f32) * focus.1).round() as i64;
        image::imageops::overlay(&mut canvas, &scaled, x, y);
        return Ok(Frame {
            time: at,
            size: [width as usize, height as usize],
            rgba: canvas.into_raw(),
        });
    }
    let output = command(&ffmpeg())
        .args(["-v", "error", "-ss", &seek_to(at)])
        .arg("-i")
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-an",
            "-vf",
            &picture.filter_at(width, height, at, 1.0),
            "-pix_fmt",
            "rgba",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    let expected = (width * height * 4) as usize;
    if output.stdout.len() < expected {
        return Err("No picture at that time.".into());
    }
    Ok(Frame {
        time: at,
        size: [width as usize, height as usize],
        rgba: output.stdout[..expected].to_vec(),
    })
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
            let Ok(mut child) = command.stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else {
                return;
            };
            let stdout = child.stdout.take().expect("piped");
            {
                let mut state = shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    /// `speed` plays the source faster or slower; frame times stay in source seconds. A source that loops (an animated
    /// picture: `Media::loop_length`) plays over and over, its frame times counting on from `from`.
    pub fn start(
        path: &Path,
        from: f64,
        fps: u32,
        width: u32,
        height: u32,
        picture: Picture,
        speed: f64,
        looped: Option<f64>,
    ) -> Self {
        // Start on a frame, so each frame's time is exactly the source time it shows.
        let from = (from * fps as f64 - 1e-6).ceil().max(0.0) / fps as f64;
        let mut command = command(&ffmpeg());
        command.args(["-v", "error"]);
        // Each time round, a loop starts from its first frame, so the way into the first one is trimmed off instead.
        let trim = match looped {
            Some(length) => {
                command.args(["-stream_loop", "-1"]);
                format!("trim=start={:.3},", from.rem_euclid(length))
            }
            None => {
                command.args(["-ss", &seek_to(from)]);
                String::new()
            }
        };
        command.arg("-i").arg(path).args([
            "-an",
            "-vf",
            &format!(
                "{trim}setpts=(PTS-STARTPTS)/{speed:.4},fps={fps},{}",
                picture.filter_at(width, height, from, speed)
            ),
            "-pix_fmt",
            "rgba",
            "-f",
            "rawvideo",
            "pipe:1",
        ]);
        let frame_bytes = (width * height * 4) as usize;
        let (ffmpeg, frames) = Background::start(command, 6, move |mut stdout, sender| {
            for index in 0.. {
                let mut rgba = vec![0u8; frame_bytes];
                if stdout.read_exact(&mut rgba).is_err() {
                    break;
                }
                let frame = Frame {
                    time: from + index as f64 * speed / fps as f64,
                    size: [width as usize, height as usize],
                    rgba,
                };
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            _ffmpeg: ffmpeg,
            frames,
            from,
        }
    }
}

/// Sound decoded from a source time for `length` seconds of playback at `speed`, as interleaved f32 samples at the
/// output's rate and channel count. Dropping it stops FFmpeg.
pub struct SoundStream {
    _ffmpeg: Background,
    pub chunks: Receiver<Vec<f32>>,
}

impl SoundStream {
    /// `filter` shapes the clip's sound (`Sound::filter`): it takes stereo, as in exports.
    pub fn start(
        path: &Path,
        from: f64,
        length: f64,
        speed: f64,
        rate: u32,
        channels: u16,
        filter: Option<&str>,
    ) -> Self {
        let mut command = command(&ffmpeg());
        command
            .args(["-v", "error", "-ss", &format!("{from:.3}")])
            .arg("-i")
            .arg(path)
            .args(["-t", &format!("{:.3}", length * speed), "-vn"]);
        let filters: Vec<String> = atempo(speed)
            .into_iter()
            .chain(filter.map(|f| format!("aformat=channel_layouts=stereo,{f}")))
            .collect();
        if !filters.is_empty() {
            command.args(["-af", &filters.join(",")]);
        }
        command.args([
            "-ac",
            &channels.to_string(),
            "-ar",
            &rate.to_string(),
            "-f",
            "f32le",
            "pipe:1",
        ]);
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
                        let samples: Vec<f32> = bytes[..whole]
                            .chunks_exact(4)
                            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                            .collect();
                        bytes.copy_within(whole..filled, 0);
                        filled -= whole;
                        if !samples.is_empty() && sender.send(samples).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Self {
            _ffmpeg: ffmpeg,
            chunks,
        }
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

    #[test]
    fn motion_follows_what_moves() {
        let (w, h) = (80, 80);
        // A bright square moving along the right edge, on black.
        let frame = |step: usize| -> Vec<u8> {
            (0..w * h)
                .map(|i| {
                    if i % w >= 70 && (i / w) / 10 == step {
                        255
                    } else {
                        0
                    }
                })
                .collect()
        };
        let mut motion = Motion::new(w, h, 4.0);
        let mut place = motion.next(&frame(0));
        assert_eq!(place, (0.5, 0.5), "nothing to compare the first frame with");
        for step in 1..8 {
            place = motion.next(&frame(step));
        }
        assert!(
            place.0 > 0.8 && place.1 > 0.5,
            "drifts right and down after it: {place:?}"
        );
        let still = motion.next(&frame(7));
        assert!((still.0 - place.0).abs() < 1e-6, "nothing moved: it stays");
    }

    #[test]
    fn blur_through_softens_both_pictures_midway() {
        // A white square on black, and a plain gray picture.
        let (w, h) = (100usize, 100usize);
        let square: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                if (40..60).contains(&(i % w)) && (40..60).contains(&(i / w)) {
                    [255, 255, 255, 255]
                } else {
                    [0, 0, 0, 255]
                }
            })
            .collect();
        let (sharp, gray) = (
            Frame {
                time: 0.0,
                size: [w, h],
                rgba: square,
            },
            Frame {
                time: 0.0,
                size: [w, h],
                rgba: [128, 128, 128, 255].repeat(w * h),
            },
        );
        let soft = blurred(&sharp, 4.0);
        let at = |f: &Frame, x: usize, y: usize| f.rgba[4 * (y * w + x)];
        // The blur spreads the square's edge and keeps the gray flat.
        assert!(at(&soft, 38, 50) > 0 && at(&soft, 50, 50) < 255 && at(&soft, 50, 50) > 200);
        assert_eq!(blurred(&gray, 4.0).rgba, gray.rgba);
        // At the very start a blur-through shows the outgoing picture sharp; midway its edge has softened.
        assert_eq!(
            crossfade_frames(&sharp, &gray, 0.0, Transition::BlurThrough).rgba,
            sharp.rgba
        );
        let midway = crossfade_frames(&sharp, &gray, 0.5, Transition::BlurThrough);
        let dissolved = crossfade_frames(&sharp, &gray, 0.5, Transition::Dissolve);
        assert!(
            at(&midway, 38, 50) > at(&dissolved, 38, 50),
            "the edge spreads beyond a plain dissolve's"
        );
    }

    /// Needs FFmpeg on PATH: an animated GIF plays round and round; a GIF of one frame is a still.
    #[test]
    fn animated_gifs_loop() {
        let dir = std::env::temp_dir().join(format!("streamcuts-gif-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (animated, single) = (dir.join("animated.gif"), dir.join("single.gif"));
        let make = |source: &str, path: &Path| {
            command(&ffmpeg())
                .args(["-v", "error", "-y", "-f", "lavfi", "-i", source])
                .arg(path)
                .status()
                .unwrap()
                .success()
        };
        // Red turning once round the color wheel, in a second at 10 frames a second.
        assert!(make("color=c=red:s=80x40:r=10:d=1,hue=h=360*t", &animated));
        assert!(make("color=c=orange:s=80x40:r=1:d=1", &single));
        let media = probe(&animated).unwrap();
        let length = media.loop_length().expect("an animated GIF loops");
        assert!((length - 1.0).abs() < 0.05, "loop length {length}");
        assert!(
            media
                .info()
                .starts_with("Animated picture · 80×40 · 10 fps · loops every 1.00 s"),
            "{}",
            media.info()
        );
        assert_eq!(probe(&single).unwrap().loop_length(), None);
        let difference = |a: &Frame, b: &Frame| {
            a.rgba
                .iter()
                .zip(&b.rgba)
                .map(|(x, y)| x.abs_diff(*y) as f64)
                .sum::<f64>()
                / a.rgba.len() as f64
        };
        // Paused, the preview asks for frames inside the loop.
        let early = still(&animated, 0.25, 80, 40, Picture::default()).unwrap();
        let later = still(&animated, 0.65, 80, 40, Picture::default()).unwrap();
        assert!(difference(&early, &later) > 20.0, "it animates");
        // Playing, the stream goes on past the end of the GIF, counting time on, and shows the same frames again.
        let stream = FrameStream::start(
            &animated,
            0.2,
            10,
            80,
            40,
            Picture::default(),
            1.0,
            Some(length),
        );
        let frames: Vec<Frame> = (0..25)
            .map_while(|_| {
                stream
                    .frames
                    .recv_timeout(std::time::Duration::from_secs(20))
                    .ok()
            })
            .collect();
        assert_eq!(frames.len(), 25, "the loop doesn't stop after one go");
        let at = |t: f64| {
            frames
                .iter()
                .find(|f| (f.time - t).abs() < 0.01)
                .unwrap_or_else(|| panic!("no frame at {t}"))
        };
        assert!(
            difference(at(0.3), at(1.3)) < 1.0,
            "a second on, it's the same frame"
        );
        assert!(difference(at(0.3), at(0.7)) > 20.0, "in between, it's not");
        // The looping FFmpeg is stopped, but may not have let go of the GIF yet.
        drop(stream);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Needs FFmpeg on PATH: makes a 2-second clip with sound, then reads it back.
    #[test]
    fn probes_and_decodes_a_generated_clip() {
        let dir = std::env::temp_dir().join(format!("streamcuts-ffmpeg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let made = command(&ffmpeg())
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=duration=2",
                "-shortest",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(made.success());
        let media = probe(&clip).unwrap();
        assert!(
            (media.frame_rate - 30.0).abs() < 0.01,
            "frame rate {}",
            media.frame_rate
        );
        assert!(
            media
                .info()
                .starts_with("Video · 320×180 · 30 fps · 0:00:02 · with sound · "),
            "{}",
            media.info()
        );
        assert_eq!(media.kind, MediaKind::Video);
        assert!(
            (media.duration - 2.0).abs() < 0.1,
            "duration {}",
            media.duration
        );
        assert!(media.has_audio && media.width == 320 && media.height == 180);
        let frame = still(&clip, 1.0, 160, 90, Picture::default()).unwrap();
        // A 440 Hz sine at FFmpeg's default amplitude measures around -21 LUFS; its loudness is a finite number.
        let lufs = loudness(&clip, 0.0, 2.0).unwrap();
        assert!((-40.0..-5.0).contains(&lufs), "{lufs} LUFS");
        // Its proxy is the same picture, as long, without sound.
        let made = dir.join("clip.proxy.mp4");
        proxy(&clip, &made).unwrap();
        let proxied = probe(&made).unwrap();
        assert!(
            proxied.kind == MediaKind::Video
                && !proxied.has_audio
                && (proxied.width, proxied.height) == (320, 180),
            "{}",
            proxied.info()
        );
        assert!(
            (proxied.duration - 2.0).abs() < 0.1,
            "proxy duration {}",
            proxied.duration
        );
        // Following a focus that pans from the left edge to the right, a vertical frame shows the picture's left end
        // at first and its right end at the last, as a fill placed at either side does.
        let pan = [
            crate::project::Focus {
                t: 0.0,
                x: 0.0,
                y: 0.5,
            },
            crate::project::Focus {
                t: 2.0,
                x: 1.0,
                y: 0.5,
            },
        ];
        let fill = |x| Picture {
            framing: Framing::Fill { x, y: 0.5 },
            ..Default::default()
        };
        let followed = Picture {
            follow: Some(crate::project::FollowRef::of(&pan)),
            ..fill(0.5)
        };
        assert_eq!(
            still(&clip, 0.1, 90, 160, followed).unwrap().rgba,
            still(&clip, 0.1, 90, 160, fill(0.0)).unwrap().rgba
        );
        assert_eq!(
            still(&clip, 1.9, 90, 160, followed).unwrap().rgba,
            still(&clip, 1.9, 90, 160, fill(1.0)).unwrap().rgba
        );
        // The test pattern moves, so following it finds points across the clip.
        let found = focus(&clip, 0.0, 2.0).unwrap();
        assert!(
            !found.is_empty() && found.iter().all(|f| (0.0..=2.0).contains(&f.t)),
            "{found:?}"
        );
        // The generated clip is one continuous test pattern: no cuts.
        assert!(scenes(&clip, 0.3).unwrap().is_empty());
        assert_eq!(frame.rgba.len(), 160 * 90 * 4);
        // A grade with no saturation leaves gray: red, green and blue alike in every pixel.
        let gray = Picture {
            grade: crate::project::Grade {
                saturation: 0.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let graded = still(&clip, 1.0, 160, 90, gray).unwrap();
        let spread = graded
            .rgba
            .chunks(4)
            .map(|p| p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]))
            .max()
            .unwrap();
        assert!(spread <= 6, "colors left in a gray picture: {spread}");
        // No gain at all: every channel's highlights (and everything below them) go to black.
        let wheels = crate::project::Wheels {
            gain: crate::project::Wheel {
                master: -1.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let dark = Picture {
            grade: crate::project::Grade {
                wheels,
                ..Default::default()
            },
            ..Default::default()
        };
        let black = still(&clip, 1.0, 160, 90, dark).unwrap();
        assert!(
            black.rgba.chunks(4).all(|p| p[..3].iter().all(|&v| v <= 4)),
            "the wheels' filter didn't apply"
        );
        // A falling master curve inverts the picture, through the filter exports use.
        let falling = crate::project::Curves {
            master: [1.0, 0.75, 0.5, 0.25, 0.0],
            ..Default::default()
        };
        let curved = Picture {
            effects: crate::project::Effects {
                curves: falling,
                ..Default::default()
            },
            ..Default::default()
        };
        let inverted = still(&clip, 1.0, 160, 90, curved).unwrap();
        let (a, b) = (
            &frame.rgba[4 * 4000..][..3],
            &inverted.rgba[4 * 4000..][..3],
        );
        assert!(
            a.iter()
                .zip(b)
                .all(|(x, y)| (*x as i32 + *y as i32 - 255).abs() < 12),
            "{a:?} vs {b:?} through the curve"
        );
        let soft = Picture {
            effects: crate::project::Effects {
                blur: 4.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let blurred = still(&clip, 1.0, 160, 90, soft).unwrap();
        assert_ne!(
            blurred.rgba, frame.rgba,
            "blur should change the decoded picture"
        );
        // The negative look inverts the picture, through the same filter exports use.
        let negative = Picture {
            effects: crate::project::Effects {
                look: Some(crate::project::Look::Negative),
                ..Default::default()
            },
            ..Default::default()
        };
        let inverted = still(&clip, 1.0, 160, 90, negative).unwrap();
        let (a, b) = (
            &frame.rgba[4 * 4000..][..3],
            &inverted.rgba[4 * 4000..][..3],
        );
        assert!(
            a.iter()
                .zip(b)
                .all(|(x, y)| (*x as i32 + *y as i32 - 255).abs() < 12),
            "{a:?} vs {b:?}"
        );
        // A LUT that inverts colors, from a path with a space and a comma (the filter graph has to take it whole).
        let cube = dir.join("negative, a test.cube");
        std::fs::write(
            &cube,
            "LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n",
        )
        .unwrap();
        let looked_up = Picture {
            lut: Some(crate::project::LutRef::of(&cube)),
            ..Default::default()
        };
        let inverted = still(&clip, 1.0, 160, 90, looked_up).unwrap();
        let (a, b) = (
            &frame.rgba[4 * 4000..][..3],
            &inverted.rgba[4 * 4000..][..3],
        );
        assert!(
            a.iter()
                .zip(b)
                .all(|(x, y)| (*x as i32 + *y as i32 - 255).abs() < 12),
            "{a:?} vs {b:?} through the LUT"
        );
        let crisp = Picture {
            effects: crate::project::Effects {
                sharpen: 1.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let sharpened = still(&clip, 1.0, 160, 90, crisp).unwrap();
        assert_ne!(
            sharpened.rgba, frame.rgba,
            "sharpen should change the decoded picture"
        );
        // Streamed frames carry their real source time: each looks like the still at its time, not its neighbors'.
        let stream = FrameStream::start(&clip, 0.5, 30, 160, 90, Picture::default(), 1.0, None);
        let frames: Vec<Frame> = stream.frames.iter().take(16).collect();
        assert!((frames[0].time - 0.5).abs() < 1e-9 && frames[0].rgba.len() == 160 * 90 * 4);
        for frame in [&frames[0], &frames[15]] {
            let unlike = |t: f64| {
                let other = still(&clip, t, 160, 90, Picture::default()).unwrap();
                frame
                    .rgba
                    .iter()
                    .zip(&other.rgba)
                    .map(|(a, b)| a.abs_diff(*b) as u64)
                    .sum::<u64>()
            };
            let (here, before, after) = (
                unlike(frame.time),
                unlike(frame.time - 1.0 / 30.0),
                unlike(frame.time + 1.0 / 30.0),
            );
            assert!(
                here < before && here < after,
                "frame at {:.3}: {here} vs {before} before, {after} after",
                frame.time
            );
        }
        drop(stream);
        // 1.5 s of stereo at 48 kHz from 0.25 s in, give or take a packet.
        let mut sound = SoundStream::start(&clip, 0.25, 1.5, 1.0, 48_000, 2, None);
        let samples: usize = sound.take_chunks().iter().map(|chunk| chunk.len()).sum();
        assert!(
            samples % 2 == 0 && (samples as i64 - 144_000).abs() < 4_000,
            "{samples} samples"
        );
        drop(sound);
        // Panned hard left: the right side is silent.
        let left = crate::project::Sound {
            pan: -1.0,
            ..Default::default()
        }
        .filter()
        .unwrap();
        let mut panned = SoundStream::start(&clip, 0.25, 0.5, 1.0, 48_000, 2, Some(&left));
        let samples: Vec<f32> = panned.take_chunks().iter().flatten().collect();
        let (l, r) = samples.chunks(2).fold((0.0f32, 0.0f32), |(l, r), s| {
            (l.max(s[0].abs()), r.max(s[1].abs()))
        });
        assert!(
            samples.len() > 40_000 && l > 0.05 && r < 1e-4,
            "{} samples, left {l}, right {r}",
            samples.len()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
