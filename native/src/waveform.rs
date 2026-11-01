//! Waveforms for the timeline: the loudest sample of every 10 ms of a file's sound, kept as a pyramid of halved levels
//! so drawing stays cheap however far out the timeline is zoomed (a 12-hour stream is 4.3 million peaks at the bottom).

use crate::ffmpeg;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

/// Peaks per second at the bottom level.
pub const PER_SECOND: f64 = 100.0;
/// The rate FFmpeg decodes at for this: plenty to find the peaks, and cheap.
const RATE: u32 = 8_000;

pub struct Waveform {
    /// `levels[0]` holds one peak (0-255) per 10 ms; each level above holds the louder of each pair below it.
    levels: Vec<Vec<u8>>,
}

impl Waveform {
    pub fn from_peaks(peaks: Vec<u8>) -> Self {
        let mut levels = vec![peaks];
        while levels.last().is_some_and(|level| level.len() > 1) {
            let below = levels.last().expect("non-empty");
            let above = below.chunks(2).map(|pair| pair.iter().copied().max().unwrap_or(0)).collect();
            levels.push(above);
        }
        Self { levels }
    }

    /// The loudest peak between source times `from` and `to` (seconds), 0-255.
    pub fn peak(&self, from: f64, to: f64) -> u8 {
        let span = ((to - from) * PER_SECOND).max(1.0);
        // The level where one peak covers about half the span: two or three peaks to look at.
        let level = (span.log2().floor() as usize).saturating_sub(1).min(self.levels.len() - 1);
        let peaks = &self.levels[level];
        let scale = PER_SECOND / (1u64 << level) as f64;
        let first = ((from.max(0.0) * scale) as usize).min(peaks.len());
        let last = ((to.max(0.0) * scale).ceil() as usize).clamp(first + 1, peaks.len().max(first + 1));
        peaks.get(first..last.min(peaks.len())).and_then(|range| range.iter().copied().max()).unwrap_or(0)
    }
}

/// Reads a file's sound through FFmpeg into a waveform. Streams, so a 12-hour file never sits in memory as samples.
/// Blocking, and slow for long files: run it on a thread of its own.
pub fn decode(path: &Path) -> Result<Waveform, String> {
    let mut child = ffmpeg::command(&ffmpeg::ffmpeg())
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    let mut stdout = child.stdout.take().expect("piped");
    let per_peak = (RATE as f64 / PER_SECOND) as usize;
    let mut peaks = Vec::new();
    let (mut loudest, mut counted) = (0.0f32, 0);
    let mut bytes = vec![0u8; 64 * 1024];
    let mut filled = 0;
    loop {
        let read = match stdout.read(&mut bytes[filled..]) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        filled += read;
        let whole = filled - filled % 4;
        for sample in bytes[..whole].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])) {
            loudest = loudest.max(sample.abs());
            counted += 1;
            if counted == per_peak {
                peaks.push((loudest.min(1.0) * 255.0).round() as u8);
                (loudest, counted) = (0.0, 0);
            }
        }
        bytes.copy_within(whole..filled, 0);
        filled -= whole;
    }
    if counted > 0 {
        peaks.push((loudest.min(1.0) * 255.0).round() as u8);
    }
    let _ = child.wait();
    if peaks.is_empty() {
        return Err("No sound to draw.".into());
    }
    Ok(Waveform::from_peaks(peaks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaks_come_from_the_right_place_at_any_zoom() {
        // Quiet everywhere but one loud 10 ms at 3.00 s, and a medium one at 7.50 s.
        let mut peaks = vec![10u8; 1000];
        peaks[300] = 250;
        peaks[750] = 120;
        let wave = Waveform::from_peaks(peaks);
        assert_eq!(wave.peak(3.0, 3.01), 250);
        assert_eq!(wave.peak(2.0, 2.5), 10);
        assert_eq!(wave.peak(7.0, 8.0), 120);
        // Zoomed far out, one column covers everything: the loudest wins.
        assert_eq!(wave.peak(0.0, 10.0), 250);
        // Past the end, and backwards, are silent rather than a panic.
        assert_eq!(wave.peak(20.0, 30.0), 0);
        assert_eq!(wave.peak(5.0, 4.0), 10);
    }

    /// Needs FFmpeg on PATH: a tone that's loud for one second and quiet for the next.
    #[test]
    fn decodes_a_file_with_ffmpeg() {
        let dir = std::env::temp_dir().join(format!("streamcuts-waveform-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tone.wav");
        let made = ffmpeg::command(&ffmpeg::ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-af", "volume='if(lt(t,1),1,0.1)':eval=frame"])
            .arg(&file)
            .status()
            .unwrap();
        assert!(made.success());
        let wave = decode(&file).unwrap();
        let (loud, quiet) = (wave.peak(0.2, 0.8), wave.peak(1.2, 1.8));
        assert!(loud > 25 && quiet < loud / 4, "loud {loud}, quiet {quiet}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
