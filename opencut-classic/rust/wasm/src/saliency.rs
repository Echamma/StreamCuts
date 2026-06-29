#![cfg(target_arch = "wasm32")]

//! WASM bindings for the motion-energy saliency analyzer.
//!
//! Mirrors the Rust API: construct a `SaliencyAnalyzer` with a known frame
//! size, then push luma frames (single-channel 8-bit) in source order.
//! Each `analyze` call returns the smoothed `(x, y, scale)` anchor for that
//! frame.

use ::saliency::{
    AnalyzeOptions as RsAnalyzeOptions, AnalyzerError, FrameSize as RsFrameSize,
    SaliencyAnalyzer as RsSaliencyAnalyzer, SaliencyPoint as RsSaliencyPoint,
};
use js_sys::Uint8Array;
use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsError, JsValue, prelude::wasm_bindgen};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaliencyAnalyzerOptionsJs {
    width: u32,
    height: u32,
    #[serde(default = "default_sample_rate")]
    sample_rate_hz: f64,
    #[serde(default = "default_tau")]
    tau_seconds: f64,
}

fn default_sample_rate() -> f64 {
    4.0
}

fn default_tau() -> f64 {
    0.5
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaliencyPointJs {
    x: f64,
    y: f64,
    scale: f64,
}

impl From<RsSaliencyPoint> for SaliencyPointJs {
    fn from(p: RsSaliencyPoint) -> Self {
        Self {
            x: p.x,
            y: p.y,
            scale: p.scale,
        }
    }
}

fn map_err(err: AnalyzerError) -> JsError {
    JsError::new(&err.to_string())
}

#[wasm_bindgen(js_name = SaliencyAnalyzer)]
pub struct SaliencyAnalyzer {
    inner: RsSaliencyAnalyzer,
}

#[wasm_bindgen(js_class = SaliencyAnalyzer)]
impl SaliencyAnalyzer {
    /// Build an analyzer for a fixed frame size. Options shape:
    /// `{ width, height, sampleRateHz?, tauSeconds? }`.
    #[wasm_bindgen(constructor)]
    pub fn new(options: JsValue) -> Result<SaliencyAnalyzer, JsError> {
        let opts: SaliencyAnalyzerOptionsJs = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let inner = RsSaliencyAnalyzer::new(
            RsFrameSize {
                width: opts.width,
                height: opts.height,
            },
            RsAnalyzeOptions {
                sample_rate_hz: opts.sample_rate_hz,
                tau_seconds: opts.tau_seconds,
            },
        )
        .map_err(map_err)?;
        Ok(Self { inner })
    }

    /// Feed one luma frame (single-channel 8-bit, row-major, no padding).
    /// Returns `{ x, y, scale }` — the smoothed anchor for this frame.
    pub fn analyze(&mut self, luma: &Uint8Array) -> Result<JsValue, JsError> {
        let bytes = luma.to_vec();
        let point = self.inner.analyze(&bytes).map_err(map_err)?;
        serde_wasm_bindgen::to_value(&SaliencyPointJs::from(point))
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Drop the cached previous frame and reset the smoother. Use when
    /// seeking discontinuously so motion energy across the seek does not
    /// produce a spurious anchor jump.
    pub fn reset(&mut self) {
        self.inner.reset()
    }

    /// The last smoothed anchor (without consuming a new frame).
    #[wasm_bindgen(js_name = lastAnchor)]
    pub fn last_anchor(&self) -> Result<JsValue, JsError> {
        serde_wasm_bindgen::to_value(&SaliencyPointJs::from(self.inner.last_anchor()))
            .map_err(|e| JsError::new(&e.to_string()))
    }
}
