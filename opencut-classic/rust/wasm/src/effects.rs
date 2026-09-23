#![cfg(target_arch = "wasm32")]

use effects::{ApplyEffectsOptions, EffectPass, UniformValue};
use gpu::wgpu;
use js_sys::Object;
use serde::Deserialize;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    import_canvas_texture, read_offscreen_canvas_property, read_serde_property, read_u32_property,
    render_texture_to_canvas, with_gpu_runtime,
};

/// A prepared table crosses the WASM boundary only when the UI changes it.
#[wasm_bindgen]
pub struct PreparedColorLut {
    inner: effects::lut::ColorLut,
}

#[wasm_bindgen]
impl PreparedColorLut {
    #[wasm_bindgen(getter)]
    pub fn identity(&self) -> bool {
        self.inner.is_identity()
    }
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.inner.size
    }
    #[wasm_bindgen(getter, js_name = domainMin)]
    pub fn domain_min(&self) -> Vec<f32> {
        self.inner.domain_min.to_vec()
    }
    #[wasm_bindgen(getter, js_name = domainMax)]
    pub fn domain_max(&self) -> Vec<f32> {
        self.inner.domain_max.to_vec()
    }
    #[wasm_bindgen(getter)]
    pub fn table(&self) -> Vec<f32> {
        self.inner.table.clone()
    }
}

#[wasm_bindgen(js_name = prepareCubeLut)]
pub fn prepare_cube_lut(text: &str) -> Result<PreparedColorLut, JsValue> {
    effects::lut::parse_cube(text)
        .map(|inner| PreparedColorLut { inner })
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name = prepareToneCurves)]
pub fn prepare_tone_curves(points: JsValue) -> Result<PreparedColorLut, JsValue> {
    let points: Vec<Vec<[f32; 2]>> =
        serde_wasm_bindgen::from_value(points).map_err(|e| JsValue::from_str(&e.to_string()))?;
    effects::lut::bake_curves(&points)
        .map(|inner| PreparedColorLut { inner })
        .map_err(|e| JsValue::from_str(&e))
}

/// Compact analytic curve data for the GPU's tone-curves pass. A sampled 3D
/// table cannot represent steep or closely spaced control points accurately.
#[wasm_bindgen]
pub struct PreparedToneCurves {
    inner: effects::lut::PreparedCurves,
}

#[wasm_bindgen]
impl PreparedToneCurves {
    #[wasm_bindgen(getter)]
    pub fn identity(&self) -> bool {
        self.inner.is_identity
    }

    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> Vec<f32> {
        self.inner.counts.to_vec()
    }

    #[wasm_bindgen(getter)]
    pub fn nodes(&self) -> Vec<f32> {
        self.inner.nodes.clone()
    }
}

#[wasm_bindgen(js_name = prepareToneCurvesExact)]
pub fn prepare_tone_curves_exact(points: JsValue) -> Result<PreparedToneCurves, JsValue> {
    let points: Vec<Vec<[f32; 2]>> =
        serde_wasm_bindgen::from_value(points).map_err(|e| JsValue::from_str(&e.to_string()))?;
    effects::lut::prepare_curves(&points)
        .map(|inner| PreparedToneCurves { inner })
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name = sampleToneCurve)]
pub fn sample_tone_curve(points: JsValue) -> Result<Vec<f32>, JsValue> {
    let points: Vec<[f32; 2]> =
        serde_wasm_bindgen::from_value(points).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let curve = effects::lut::ToneCurve::new(&points).map_err(|e| JsValue::from_str(&e))?;
    Ok((0..=128).map(|i| curve.evaluate(i as f32 / 128.)).collect())
}

struct ApplyEffectPassesOptions {
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
    passes: Vec<EffectPassInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectPassInput {
    shader: String,
    uniforms: Vec<EffectUniformInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectUniformInput {
    name: String,
    value: Vec<f32>,
}

#[wasm_bindgen(js_name = applyEffectPasses)]
pub fn apply_effect_passes(options: JsValue) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    let ApplyEffectPassesOptions {
        source,
        width,
        height,
        passes,
    } = parse_apply_effect_passes_options(options)?;

    with_gpu_runtime(|runtime| {
        let source_texture = import_canvas_texture(
            &runtime.context,
            &source,
            width,
            height,
            "effects-input-texture",
        );
        let effect_passes = map_effect_passes(passes);
        let result_texture = runtime
            .effects
            .apply(
                &runtime.context,
                ApplyEffectsOptions {
                    source: &source_texture,
                    width,
                    height,
                    passes: &effect_passes,
                },
            )
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        render_texture_to_canvas(&runtime.context, &result_texture, width, height)
    })
}

fn map_effect_passes(effect_passes: Vec<EffectPassInput>) -> Vec<EffectPass> {
    effect_passes
        .into_iter()
        .map(|pass| EffectPass {
            shader: pass.shader,
            uniforms: pass
                .uniforms
                .into_iter()
                .map(|uniform| {
                    let value = if uniform.value.len() == 1 {
                        UniformValue::Number(uniform.value[0])
                    } else {
                        UniformValue::Vector(uniform.value)
                    };
                    (uniform.name, value)
                })
                .collect(),
        })
        .collect()
}

fn parse_apply_effect_passes_options(value: JsValue) -> Result<ApplyEffectPassesOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("applyEffectPasses expects an options object"))?;

    Ok(ApplyEffectPassesOptions {
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
        passes: read_serde_property(&object, "passes")?,
    })
}
