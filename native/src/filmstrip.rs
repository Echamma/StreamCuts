//! Filmstrips: small frames along a video, tiled across its clips on the timeline. One FFmpeg run per file, on a
//! thread of its own; long files decode only keyframes, so a 12-hour stream takes seconds rather than hours.

use crate::{cache, ffmpeg};
use egui::{Color32, ColorImage, Rect, TextureHandle, TextureOptions, pos2};
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

pub const WIDTH: u32 = 96;
pub const HEIGHT: u32 = 54;
/// At most this many frames per file, at least a second apart.
const MOST: f64 = 120.0;
/// Frames per row of the texture they're packed into.
const COLUMNS: usize = 16;

/// Frames as decoded: `frames[i]` shows source time `i * interval`.
pub struct Film {
    pub interval: f64,
    pub frames: Vec<Vec<u8>>,
}

/// The film from the cache in `cache_dir` (its interval, then the frames), or decoded (and cached).
pub fn cached(path: &Path, duration: f64, cache_dir: &Path) -> Result<Film, String> {
    let frame = (WIDTH * HEIGHT * 4) as usize;
    let entry = cache::entry(cache_dir, path, "strip");
    if let Some(bytes) = entry.as_deref().and_then(cache::read).filter(|b| b.len() > 8 && (b.len() - 8) % frame == 0) {
        let interval = f64::from_le_bytes(bytes[..8].try_into().expect("8 bytes"));
        return Ok(Film { interval, frames: bytes[8..].chunks(frame).map(<[u8]>::to_vec).collect() });
    }
    let film = decode(path, duration)?;
    if let Some(entry) = entry {
        let mut bytes = film.interval.to_le_bytes().to_vec();
        film.frames.iter().for_each(|f| bytes.extend_from_slice(f));
        cache::write(&entry, &bytes);
    }
    Ok(film)
}

pub fn decode(path: &Path, duration: f64) -> Result<Film, String> {
    let interval = (duration / MOST).max(1.0);
    let mut command = ffmpeg::command(&ffmpeg::ffmpeg());
    command.args(["-v", "error"]);
    if duration > 120.0 {
        // Keyframes come every few seconds in most footage; frames between them aren't worth decoding for this.
        command.args(["-skip_frame", "nokey"]);
    }
    let mut child = command
        .arg("-i")
        .arg(path)
        .args(["-an", "-vf", &format!("fps=1/{interval:.4},{}", ffmpeg::scale_filter(WIDTH, HEIGHT)), "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut frames = Vec::new();
    loop {
        let mut rgba = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
        if stdout.read_exact(&mut rgba).is_err() || frames.len() >= MOST as usize + 2 {
            break;
        }
        frames.push(rgba);
    }
    let _ = child.kill();
    let _ = child.wait();
    if frames.is_empty() {
        return Err("No pictures to show.".into());
    }
    Ok(Film { interval, frames })
}

/// A film packed into one texture, ready to draw.
pub struct Strip {
    pub texture: TextureHandle,
    interval: f64,
    count: usize,
    rows: usize,
}

impl Strip {
    pub fn new(ctx: &egui::Context, name: &str, film: Film) -> Self {
        let count = film.frames.len();
        let rows = count.div_ceil(COLUMNS);
        let (w, h) = (WIDTH as usize, HEIGHT as usize);
        let mut atlas = ColorImage::filled([COLUMNS * w, rows * h], Color32::BLACK);
        for (index, frame) in film.frames.iter().enumerate() {
            let (left, top) = ((index % COLUMNS) * w, (index / COLUMNS) * h);
            for y in 0..h {
                for x in 0..w {
                    let p = (y * w + x) * 4;
                    atlas[(left + x, top + y)] = Color32::from_rgba_unmultiplied(frame[p], frame[p + 1], frame[p + 2], frame[p + 3]);
                }
            }
        }
        let texture = ctx.load_texture(name, atlas, TextureOptions::LINEAR);
        Self { texture, interval: film.interval, count, rows }
    }

    /// Where in the texture the frame nearest to source time `t` is, as UV coordinates.
    pub fn uv(&self, t: f64) -> Rect {
        let index = ((t / self.interval).round().max(0.0) as usize).min(self.count - 1);
        let (u, v) = (1.0 / COLUMNS as f32, 1.0 / self.rows as f32);
        let (column, row) = ((index % COLUMNS) as f32, (index / COLUMNS) as f32);
        Rect::from_min_max(pos2(column * u, row * v), pos2((column + 1.0) * u, (row + 1.0) * v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs FFmpeg on PATH.
    #[test]
    fn decodes_frames_a_second_apart_and_finds_them_in_the_texture() {
        let dir = std::env::temp_dir().join(format!("streamcuts-filmstrip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        let made = ffmpeg::command(&ffmpeg::ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=5", "-pix_fmt", "yuv420p"])
            .arg(&file)
            .status()
            .unwrap();
        assert!(made.success());
        let film = cached(&file, 5.0, &dir).unwrap();
        assert_eq!(film.interval, 1.0);
        let again = cached(&file, 5.0, &dir).unwrap();
        assert_eq!((again.interval, &again.frames), (film.interval, &film.frames), "the second time comes from the cache");
        assert!((5..=6).contains(&film.frames.len()), "{} frames", film.frames.len());
        assert_ne!(film.frames[0], film.frames[3], "different times, different pictures");
        let ctx = egui::Context::default();
        let strip = Strip::new(&ctx, "test-strip", film);
        let first = strip.uv(0.2);
        assert_eq!((first.min.x, first.min.y), (0.0, 0.0));
        assert_eq!(strip.uv(2.9).min.x, 3.0 / COLUMNS as f32);
        assert_eq!(strip.uv(99.0).min.x, strip.uv(4.0).min.x.max(strip.uv(5.0).min.x), "past the end: the last frame");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
