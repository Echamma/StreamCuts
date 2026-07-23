// Primary color-wheels grade (COL-002 / COL-004). This transcribes
// `color_grade::apply_color_grade` verbatim; keep the two in sync (the Rust
// crate carries the unit tests). Uniform layout is `ColorGradeParams::gpu_uniforms`:
// 6 vec4 lanes — lift, gamma, gain, offset (each rgb + master in .w), then
// (contrast, pivot, saturation, temperature) and (tint, hue, _, _).

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct ColorWheels {
    lift: vec4f,
    gamma: vec4f,
    gain: vec4f,
    offset: vec4f,
    scalars_a: vec4f, // contrast, pivot, saturation, temperature
    scalars_b: vec4f, // tint, hue, _, _
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> u: ColorWheels;

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

fn resolved(wheel: vec4f) -> vec3f {
    return wheel.xyz + vec3f(wheel.w);
}

fn lift_gamma_gain_offset(
    c: vec3f,
    lift: vec3f,
    gamma: vec3f,
    gain: vec3f,
    offset: vec3f,
) -> vec3f {
    var v = c * gain + lift * (vec3f(1.0) - c) + offset;
    v = clamp(v, vec3f(0.0), vec3f(1.0));
    let g = max(gamma, vec3f(1.0e-3));
    return pow(v, vec3f(1.0) / g);
}

fn rotate_hue(c: vec3f, degrees: f32) -> vec3f {
    if (degrees == 0.0) {
        return c;
    }
    let y = dot(c, vec3f(0.299, 0.587, 0.114));
    let i = dot(c, vec3f(0.596, -0.274, -0.322));
    let q = dot(c, vec3f(0.211, -0.523, 0.312));
    let rad = radians(degrees);
    let s = sin(rad);
    let cs = cos(rad);
    let i2 = i * cs - q * s;
    let q2 = i * s + q * cs;
    return vec3f(
        y + 0.956 * i2 + 0.621 * q2,
        y - 0.272 * i2 - 0.647 * q2,
        y - 1.106 * i2 + 1.703 * q2,
    );
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    var c = src.rgb;

    let contrast = u.scalars_a.x;
    let pivot = u.scalars_a.y;
    let saturation = u.scalars_a.z;
    let temperature = u.scalars_a.w;
    let tint = u.scalars_b.x;
    let hue = u.scalars_b.y;

    // 1. white balance (temperature / tint) as channel gains
    c.r = c.r * (1.0 + 0.2 * temperature);
    c.b = c.b * (1.0 - 0.2 * temperature);
    c.g = c.g * (1.0 - 0.2 * tint);

    // 2. lift / gamma / gain / offset
    c = lift_gamma_gain_offset(
        c,
        resolved(u.lift),
        resolved(u.gamma),
        resolved(u.gain),
        resolved(u.offset),
    );

    // 3. contrast around pivot
    c = (c - vec3f(pivot)) * contrast + vec3f(pivot);

    // 4. saturation (luma-preserving)
    let luma = dot(c, LUMA);
    c = vec3f(luma) + (c - vec3f(luma)) * saturation;

    // 5. hue rotation
    c = rotate_hue(c, hue);

    c = clamp(c, vec3f(0.0), vec3f(1.0));
    return vec4f(c, src.a);
}
