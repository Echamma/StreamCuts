#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct PreparedRgbParade {
    inner: scopes::RgbParade,
}

#[wasm_bindgen]
impl PreparedRgbParade {
    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> Vec<u32> {
        self.inner.counts.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn columns(&self) -> u32 {
        self.inner.columns as u32
    }

    #[wasm_bindgen(getter)]
    pub fn bins(&self) -> u32 {
        self.inner.bins as u32
    }

    #[wasm_bindgen(getter)]
    pub fn peak(&self) -> u32 {
        self.inner.peak
    }
}

#[wasm_bindgen(js_name = computeRgbParade)]
pub fn compute_rgb_parade(
    pixels: &[u8],
    width: u32,
    height: u32,
    columns: u32,
    bins: u32,
) -> Result<PreparedRgbParade, JsValue> {
    scopes::compute_rgb_parade(
        pixels,
        width as usize,
        height as usize,
        columns as usize,
        bins as usize,
    )
    .map(|inner| PreparedRgbParade { inner })
    .map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub struct PreparedVectorscope {
    inner: scopes::Vectorscope,
}

#[wasm_bindgen]
impl PreparedVectorscope {
    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> Vec<u32> {
        self.inner.counts.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.inner.size as u32
    }

    #[wasm_bindgen(getter)]
    pub fn peak(&self) -> u32 {
        self.inner.peak
    }
}

#[wasm_bindgen(js_name = computeVectorscope)]
pub fn compute_vectorscope(
    pixels: &[u8],
    width: u32,
    height: u32,
    size: u32,
) -> Result<PreparedVectorscope, JsValue> {
    scopes::compute_vectorscope(pixels, width as usize, height as usize, size as usize)
        .map(|inner| PreparedVectorscope { inner })
        .map_err(JsValue::from_str)
}
