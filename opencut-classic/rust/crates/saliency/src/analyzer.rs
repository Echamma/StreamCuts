//! Motion-energy saliency analyzer.
//!
//! The analyzer keeps the previous luma frame and an x/y smoother. Each
//! `analyze` call subtracts the previous frame, bins the absolute
//! differences into a coarse grid, and picks the highest-energy cell's
//! center as the salient anchor. The smoother rides over noise.

use serde::{Deserialize, Serialize};

use crate::smoother::{LowPassSmoother, SmoothingOptions};

/// Grid resolution used to bin per-pixel motion energy. 8x8 = 64 cells —
/// coarse enough to be cheap on a 1080p luma frame, fine enough to track
/// a moving face within a frame.
const GRID: usize = 8;

/// Minimum total motion energy below which the analyzer holds the previous
/// anchor instead of trusting the (noisy) grid. Expressed as the average
/// absolute luma delta over the whole frame (out of 255). 0.5 is well
/// below visible motion but above sensor noise.
const MOTION_FLOOR_AVG_DELTA: f64 = 0.5;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct FrameSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct AnalyzeOptions {
    /// Sample rate (Hz) used to compute the smoother time constant.
    pub sample_rate_hz: f64,
    /// Saliency-smoothing time constant (seconds). See [`SmoothingOptions`].
    pub tau_seconds: f64,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        Self {
            sample_rate_hz: 4.0,
            tau_seconds: 0.5,
        }
    }
}

impl AnalyzeOptions {
    fn smoothing(&self) -> SmoothingOptions {
        let dt = if self.sample_rate_hz <= 0.0 {
            0.25
        } else {
            1.0 / self.sample_rate_hz
        };
        SmoothingOptions {
            tau_seconds: self.tau_seconds,
            dt_seconds: dt,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct SaliencyPoint {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

impl SaliencyPoint {
    /// The neutral output: centered, no zoom. Matches `REFRAME_IDENTITY`
    /// on the TS side so downstream consumers can treat "no analyzer
    /// output yet" the same as "no reframe".
    pub fn identity() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            scale: 1.0,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AnalyzerError {
    #[error("luma buffer length {len} does not match {width}x{height}")]
    SizeMismatch {
        len: usize,
        width: u32,
        height: u32,
    },
    #[error("frame size {width}x{height} is empty")]
    EmptyFrame { width: u32, height: u32 },
}

pub struct SaliencyAnalyzer {
    size: FrameSize,
    previous_luma: Option<Vec<u8>>,
    x_smoother: LowPassSmoother,
    y_smoother: LowPassSmoother,
    last_anchor: SaliencyPoint,
}

impl SaliencyAnalyzer {
    pub fn new(size: FrameSize, options: AnalyzeOptions) -> Result<Self, AnalyzerError> {
        if size.width == 0 || size.height == 0 {
            return Err(AnalyzerError::EmptyFrame {
                width: size.width,
                height: size.height,
            });
        }
        let smoothing = options.smoothing();
        Ok(Self {
            size,
            previous_luma: None,
            x_smoother: LowPassSmoother::new(smoothing),
            y_smoother: LowPassSmoother::new(smoothing),
            last_anchor: SaliencyPoint::identity(),
        })
    }

    pub fn size(&self) -> FrameSize {
        self.size
    }

    /// Feed one luma frame (single-channel 8-bit, row-major, no padding).
    /// Returns the smoothed anchor for this frame.
    pub fn analyze(&mut self, luma: &[u8]) -> Result<SaliencyPoint, AnalyzerError> {
        let expected = (self.size.width as usize) * (self.size.height as usize);
        if luma.len() != expected {
            return Err(AnalyzerError::SizeMismatch {
                len: luma.len(),
                width: self.size.width,
                height: self.size.height,
            });
        }

        let raw_anchor = match self.previous_luma.as_deref() {
            None => self.last_anchor,
            Some(prev) => motion_energy_anchor(prev, luma, self.size, self.last_anchor),
        };

        // Stash this frame for the next call. Reuse the existing allocation
        // to avoid per-call heap churn at high frame rates.
        match self.previous_luma.as_mut() {
            Some(buf) => {
                buf.clear();
                buf.extend_from_slice(luma);
            }
            None => {
                self.previous_luma = Some(luma.to_vec());
            }
        }

        let smoothed = SaliencyPoint {
            x: self.x_smoother.push(raw_anchor.x).clamp(0.0, 1.0),
            y: self.y_smoother.push(raw_anchor.y).clamp(0.0, 1.0),
            scale: raw_anchor.scale,
        };
        self.last_anchor = smoothed;
        Ok(smoothed)
    }

    pub fn last_anchor(&self) -> SaliencyPoint {
        self.last_anchor
    }

    pub fn reset(&mut self) {
        self.previous_luma = None;
        self.x_smoother.reset();
        self.y_smoother.reset();
        self.last_anchor = SaliencyPoint::identity();
    }
}

fn motion_energy_anchor(
    previous: &[u8],
    current: &[u8],
    size: FrameSize,
    fallback: SaliencyPoint,
) -> SaliencyPoint {
    let width = size.width as usize;
    let height = size.height as usize;
    let mut cells = [0.0_f64; GRID * GRID];
    let mut total = 0.0_f64;

    for y in 0..height {
        let cell_y = (y * GRID) / height;
        let row_offset = y * width;
        let row_prev = &previous[row_offset..row_offset + width];
        let row_cur = &current[row_offset..row_offset + width];
        for x in 0..width {
            let cell_x = (x * GRID) / width;
            let delta = (row_cur[x] as i32 - row_prev[x] as i32).unsigned_abs() as f64;
            cells[cell_y * GRID + cell_x] += delta;
            total += delta;
        }
    }

    let pixels = (width * height) as f64;
    let avg_delta = if pixels == 0.0 { 0.0 } else { total / pixels };
    if avg_delta < MOTION_FLOOR_AVG_DELTA {
        return fallback;
    }

    let (best_idx, _) = cells
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or((0, &0.0));
    let cell_x = (best_idx % GRID) as f64;
    let cell_y = (best_idx / GRID) as f64;
    SaliencyPoint {
        x: (cell_x + 0.5) / GRID as f64,
        y: (cell_y + 0.5) / GRID as f64,
        scale: 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(size: FrameSize, value: u8) -> Vec<u8> {
        vec![value; (size.width as usize) * (size.height as usize)]
    }

    fn with_bright_block(size: FrameSize, base: u8, block_value: u8, cell: (usize, usize)) -> Vec<u8> {
        let mut buf = solid(size, base);
        let width = size.width as usize;
        let height = size.height as usize;
        let (cell_x, cell_y) = cell;
        let x0 = (cell_x * width) / GRID;
        let x1 = ((cell_x + 1) * width) / GRID;
        let y0 = (cell_y * height) / GRID;
        let y1 = ((cell_y + 1) * height) / GRID;
        for y in y0..y1 {
            for x in x0..x1 {
                buf[y * width + x] = block_value;
            }
        }
        buf
    }

    #[test]
    fn rejects_size_mismatch() {
        let mut analyzer = SaliencyAnalyzer::new(
            FrameSize { width: 8, height: 8 },
            AnalyzeOptions::default(),
        )
        .ok()
        .unwrap();
        match analyzer.analyze(&[0; 10]) {
            Err(AnalyzerError::SizeMismatch { .. }) => {}
            other => panic!("expected SizeMismatch, got {:?}", other.map(|_| "Ok")),
        }
    }

    #[test]
    fn rejects_empty_frame() {
        match SaliencyAnalyzer::new(
            FrameSize { width: 0, height: 0 },
            AnalyzeOptions::default(),
        ) {
            Err(AnalyzerError::EmptyFrame { .. }) => {}
            _ => panic!("expected EmptyFrame"),
        }
    }

    #[test]
    fn first_frame_returns_identity_center() {
        let size = FrameSize { width: 16, height: 16 };
        let mut analyzer = SaliencyAnalyzer::new(size, AnalyzeOptions::default()).unwrap();
        let p = analyzer.analyze(&solid(size, 128)).unwrap();
        assert_eq!(p, SaliencyPoint::identity());
    }

    #[test]
    fn static_video_holds_identity() {
        let size = FrameSize { width: 16, height: 16 };
        let mut analyzer = SaliencyAnalyzer::new(size, AnalyzeOptions::default()).unwrap();
        for _ in 0..10 {
            analyzer.analyze(&solid(size, 128)).unwrap();
        }
        let last = analyzer.last_anchor();
        assert!((last.x - 0.5).abs() < 1e-9);
        assert!((last.y - 0.5).abs() < 1e-9);
        assert_eq!(last.scale, 1.0);
    }

    #[test]
    fn anchor_drifts_toward_moving_block() {
        // A single grid cell flips from 0 to 255 between consecutive frames.
        // The smoother starts at center (0.5, 0.5) and converges toward
        // the bright cell's normalized center.
        let size = FrameSize { width: 64, height: 64 };
        let mut analyzer = SaliencyAnalyzer::new(size, AnalyzeOptions::default()).unwrap();
        let base = solid(size, 0);
        let with_block = with_bright_block(size, 0, 255, (6, 6));
        analyzer.analyze(&base).unwrap();

        // Feed the alternating frames many times so the smoother locks in.
        for _ in 0..30 {
            analyzer.analyze(&with_block).unwrap();
            analyzer.analyze(&base).unwrap();
        }

        // Cell (6, 6) center = (6.5/8, 6.5/8) = (0.8125, 0.8125)
        let target_x = 6.5 / GRID as f64;
        let target_y = 6.5 / GRID as f64;
        let last = analyzer.last_anchor();
        // The anchor should be much closer to the bright block than to center.
        assert!(
            (last.x - target_x).abs() < (last.x - 0.5).abs(),
            "x={} target={}", last.x, target_x,
        );
        assert!(
            (last.y - target_y).abs() < (last.y - 0.5).abs(),
            "y={} target={}", last.y, target_y,
        );
    }

    #[test]
    fn reset_returns_to_identity() {
        let size = FrameSize { width: 16, height: 16 };
        let mut analyzer = SaliencyAnalyzer::new(size, AnalyzeOptions::default()).unwrap();
        analyzer.analyze(&solid(size, 100)).unwrap();
        analyzer.analyze(&solid(size, 200)).unwrap();
        analyzer.reset();
        assert_eq!(analyzer.last_anchor(), SaliencyPoint::identity());
    }
}
