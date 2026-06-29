//! Per-frame motion-energy saliency for auto-reframe.
//!
//! Public model: feed luma frames in roughly sample order, get back a
//! `SaliencyPoint { x, y, scale }` per sample where `(x, y)` is the
//! salient anchor in normalized 0..1 source coordinates and `scale >= 1`
//! is a recommended zoom factor. Smoothed across samples via a single-pole
//! IIR low-pass so it doesn't jitter frame-to-frame.
//!
//! v1 = pure motion-energy: subtract the previous luma frame, weight an
//! 8x8 grid by absolute difference, and pick the brightest cell's center.
//! When the frame is static (no motion energy) we hold the previous anchor
//! and fall back to image center at startup. The scale stays at 1.0 — a
//! face detector or higher-order target sizing is v2.

mod analyzer;
mod smoother;

pub use analyzer::{
    AnalyzeOptions, SaliencyAnalyzer, SaliencyPoint, FrameSize, AnalyzerError,
};
pub use smoother::{LowPassSmoother, SmoothingOptions};
