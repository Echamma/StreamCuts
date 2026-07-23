//! Primary color-grade math (COL-002 / COL-004).
//!
//! This pure crate is the single source of truth for the grade algorithm. The
//! WGSL shader `effects/src/shaders/color_wheels.wgsl` transcribes
//! [`apply_color_grade`] verbatim, and the `effects` pipeline packs
//! [`ColorGradeParams::gpu_uniforms`] into the shader's uniform buffer — so the
//! CPU reference, the GPU packing, and the shader all share one definition. The
//! unit tests here pin the behaviour the shader must match.
//!
//! All math is on normalized sRGB in `[0,1]` with standard Resolve-style
//! primary semantics. Order of operations (a primaries bar, top to bottom):
//!   1. white balance (temperature / tint) as channel gains
//!   2. lift / gamma / gain / offset (ASC-CDL-ish, per-channel + master)
//!   3. contrast around a pivot
//!   4. saturation (luma-preserving, Rec.709 weights)
//!   5. hue rotation
//! Every stage is identity at its neutral value, so the default params are a
//! byte-exact no-op.

/// Rec.709 luma weights (also used by the saturation stage).
pub const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// A wheel value: an RGB balance plus a master (luma) offset applied to all
/// three channels. Matches a Resolve trackball (ring = master, point = RGB).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wheel {
    pub rgb: [f32; 3],
    pub master: f32,
}

impl Wheel {
    /// Effective per-channel value = rgb + master.
    pub fn resolved(&self) -> [f32; 3] {
        [
            self.rgb[0] + self.master,
            self.rgb[1] + self.master,
            self.rgb[2] + self.master,
        ]
    }

    /// `[r, g, b, master]` — the GPU vec4 lane for this wheel.
    fn lane(&self) -> [f32; 4] {
        [self.rgb[0], self.rgb[1], self.rgb[2], self.master]
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorGradeParams {
    pub lift: Wheel,
    pub gamma: Wheel,
    pub gain: Wheel,
    pub offset: Wheel,
    pub contrast: f32,
    pub pivot: f32,
    pub saturation: f32,
    /// Warm (+) / cool (-), roughly `[-1, 1]`.
    pub temperature: f32,
    /// Magenta (+) / green (-), roughly `[-1, 1]`.
    pub tint: f32,
    /// Hue rotation in degrees.
    pub hue: f32,
}

impl Default for ColorGradeParams {
    fn default() -> Self {
        Self {
            lift: Wheel { rgb: [0.0; 3], master: 0.0 },
            gamma: Wheel { rgb: [1.0; 3], master: 0.0 },
            gain: Wheel { rgb: [1.0; 3], master: 0.0 },
            offset: Wheel { rgb: [0.0; 3], master: 0.0 },
            contrast: 1.0,
            pivot: 0.5,
            saturation: 1.0,
            temperature: 0.0,
            tint: 0.0,
            hue: 0.0,
        }
    }
}

impl ColorGradeParams {
    /// The 6 `vec4` lanes the WGSL shader reads (24 floats):
    /// `[lift, gamma, gain, offset, (contrast,pivot,saturation,temperature), (tint,hue,0,0)]`.
    pub fn gpu_uniforms(&self) -> [[f32; 4]; 6] {
        [
            self.lift.lane(),
            self.gamma.lane(),
            self.gain.lane(),
            self.offset.lane(),
            [self.contrast, self.pivot, self.saturation, self.temperature],
            [self.tint, self.hue, 0.0, 0.0],
        ]
    }
}

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// White-balance channel gains. Temperature warms (boost R, cut B); tint pushes
/// magenta (cut G). Scaled gently (0.2) so the full `[-1,1]` range stays usable.
fn white_balance(mut c: [f32; 3], temperature: f32, tint: f32) -> [f32; 3] {
    c[0] *= 1.0 + 0.2 * temperature;
    c[2] *= 1.0 - 0.2 * temperature;
    c[1] *= 1.0 - 0.2 * tint;
    c
}

/// Lift/gamma/gain/offset for one channel. `gamma` uses a `1/g` exponent so a
/// gamma of 1 is identity and >1 brightens mids (Resolve convention).
fn lift_gamma_gain_offset(c: f32, lift: f32, gamma: f32, gain: f32, offset: f32) -> f32 {
    let mut v = c * gain + lift * (1.0 - c) + offset;
    v = clamp01(v);
    let g = gamma.max(1.0e-3);
    v.powf(1.0 / g)
}

/// Rotate hue by `degrees` using the standard luma-preserving YIQ rotation.
fn rotate_hue(c: [f32; 3], degrees: f32) -> [f32; 3] {
    if degrees == 0.0 {
        return c;
    }
    let y = dot(c, [0.299, 0.587, 0.114]);
    let i = dot(c, [0.596, -0.274, -0.322]);
    let q = dot(c, [0.211, -0.523, 0.312]);
    let radians = degrees.to_radians();
    let (sin, cos) = radians.sin_cos();
    let i2 = i * cos - q * sin;
    let q2 = i * sin + q * cos;
    [
        y + 0.956 * i2 + 0.621 * q2,
        y - 0.272 * i2 - 0.647 * q2,
        y - 1.106 * i2 + 1.703 * q2,
    ]
}

/// Apply the full primary grade to one normalized RGB sample.
pub fn apply_color_grade(rgb: [f32; 3], params: &ColorGradeParams) -> [f32; 3] {
    let mut c = white_balance(rgb, params.temperature, params.tint);

    let lift = params.lift.resolved();
    let gamma = params.gamma.resolved();
    let gain = params.gain.resolved();
    let offset = params.offset.resolved();
    for ch in 0..3 {
        c[ch] = lift_gamma_gain_offset(c[ch], lift[ch], gamma[ch], gain[ch], offset[ch]);
    }

    for ch in 0..3 {
        c[ch] = (c[ch] - params.pivot) * params.contrast + params.pivot;
    }

    let luma = dot(c, LUMA);
    for ch in 0..3 {
        c[ch] = luma + (c[ch] - luma) * params.saturation;
    }

    c = rotate_hue(c, params.hue);

    [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: [f32; 3], b: [f32; 3], eps: f32) {
        for ch in 0..3 {
            assert!(
                (a[ch] - b[ch]).abs() < eps,
                "channel {ch}: {} vs {}",
                a[ch],
                b[ch]
            );
        }
    }

    #[test]
    fn identity_is_a_no_op() {
        let p = ColorGradeParams::default();
        for sample in [[0.0, 0.0, 0.0], [0.5, 0.25, 0.75], [1.0, 1.0, 1.0]] {
            approx(apply_color_grade(sample, &p), sample, 1.0e-5);
        }
    }

    #[test]
    fn gain_scales_toward_white() {
        let mut p = ColorGradeParams::default();
        p.gain = Wheel { rgb: [0.5, 0.5, 0.5], master: 0.0 };
        approx(apply_color_grade([0.5, 0.5, 0.5], &p), [0.25, 0.25, 0.25], 1.0e-5);
    }

    #[test]
    fn lift_raises_blacks_but_not_whites() {
        let mut p = ColorGradeParams::default();
        p.lift = Wheel { rgb: [0.2, 0.2, 0.2], master: 0.0 };
        approx(apply_color_grade([0.0, 0.0, 0.0], &p), [0.2, 0.2, 0.2], 1.0e-5);
        approx(apply_color_grade([1.0, 1.0, 1.0], &p), [1.0, 1.0, 1.0], 1.0e-5);
    }

    #[test]
    fn master_offsets_all_channels() {
        let mut p = ColorGradeParams::default();
        p.gain = Wheel { rgb: [1.0, 1.0, 1.0], master: -0.5 };
        approx(apply_color_grade([0.4, 0.6, 0.8], &p), [0.2, 0.3, 0.4], 1.0e-5);
    }

    #[test]
    fn saturation_zero_produces_grey_at_luma() {
        let mut p = ColorGradeParams::default();
        p.saturation = 0.0;
        let out = apply_color_grade([0.8, 0.2, 0.1], &p);
        let luma = dot([0.8, 0.2, 0.1], LUMA);
        approx(out, [luma, luma, luma], 1.0e-5);
    }

    #[test]
    fn contrast_pushes_away_from_pivot() {
        let mut p = ColorGradeParams::default();
        p.contrast = 2.0;
        p.pivot = 0.5;
        approx(apply_color_grade([0.5, 0.5, 0.5], &p), [0.5, 0.5, 0.5], 1.0e-5);
        assert!(apply_color_grade([0.75, 0.75, 0.75], &p)[0] > 0.75);
        assert!(apply_color_grade([0.25, 0.25, 0.25], &p)[0] < 0.25);
    }

    #[test]
    fn temperature_warms() {
        let mut p = ColorGradeParams::default();
        p.temperature = 1.0;
        let out = apply_color_grade([0.5, 0.5, 0.5], &p);
        assert!(out[0] > out[2], "warm should push red above blue");
    }

    #[test]
    fn output_is_clamped() {
        let mut p = ColorGradeParams::default();
        p.gain = Wheel { rgb: [4.0, 4.0, 4.0], master: 0.0 };
        let out = apply_color_grade([0.9, 0.9, 0.9], &p);
        for ch in 0..3 {
            assert!(out[ch] <= 1.0 && out[ch] >= 0.0);
        }
    }

    #[test]
    fn hue_rotation_identity_at_zero_and_preserves_luma() {
        let p = ColorGradeParams { hue: 0.0, ..Default::default() };
        approx(apply_color_grade([0.6, 0.3, 0.1], &p), [0.6, 0.3, 0.1], 1.0e-5);

        let mut rot = ColorGradeParams::default();
        rot.hue = 120.0;
        let input = [0.6, 0.3, 0.1];
        let out = apply_color_grade(input, &rot);
        assert!((dot(input, LUMA) - dot(out, LUMA)).abs() < 0.05);
    }

    #[test]
    fn gpu_uniforms_layout_matches_params() {
        let mut p = ColorGradeParams::default();
        p.lift = Wheel { rgb: [0.1, 0.2, 0.3], master: 0.4 };
        p.contrast = 1.5;
        p.pivot = 0.4;
        p.saturation = 0.8;
        p.temperature = 0.2;
        p.tint = -0.1;
        p.hue = 30.0;
        let u = p.gpu_uniforms();
        assert_eq!(u[0], [0.1, 0.2, 0.3, 0.4]);
        assert_eq!(u[4], [1.5, 0.4, 0.8, 0.2]);
        assert_eq!(u[5], [-0.1, 30.0, 0.0, 0.0]);
    }
}
