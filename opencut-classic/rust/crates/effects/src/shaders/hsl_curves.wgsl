// Four HSL curves in one pass. Each table row stores hue→hue/sat/lum and
// lightness→sat. Hue samples wrap; lightness samples clamp at the endpoints.
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct HslParams {
    table: array<vec4f, 256>,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> u: HslParams;

fn sample_curve(curve_type: u32, position: f32) -> f32 {
    if (curve_type == 3u) {
        let p = clamp(position, 0.0, 1.0) * 255.0;
        let low = u32(floor(p));
        let high = min(low + 1u, 255u);
        return mix(u.table[low][curve_type], u.table[high][curve_type], fract(p));
    }
    let p = fract(position) * 256.0;
    let low = u32(floor(p));
    let high = (low + 1u) % 256u;
    return mix(u.table[low][curve_type], u.table[high][curve_type], fract(p));
}

fn rgb_to_hsl(rgb: vec3f) -> vec3f {
    let greatest = max(rgb.r, max(rgb.g, rgb.b));
    let least = min(rgb.r, min(rgb.g, rgb.b));
    let chroma = greatest - least;
    let lightness = (greatest + least) * 0.5;
    if (chroma < 0.000001) {
        return vec3f(0.0, 0.0, lightness);
    }
    let saturation = chroma / max(0.000001, 1.0 - abs(2.0 * lightness - 1.0));
    var hue = 0.0;
    if (greatest == rgb.r) {
        hue = (rgb.g - rgb.b) / chroma;
    } else if (greatest == rgb.g) {
        hue = (rgb.b - rgb.r) / chroma + 2.0;
    } else {
        hue = (rgb.r - rgb.g) / chroma + 4.0;
    }
    return vec3f(fract(hue / 6.0 + 1.0), saturation, lightness);
}

fn hue_channel(hue: f32, saturation: f32, lightness: f32, offset: f32) -> f32 {
    let k = fract((offset + hue * 12.0) / 12.0) * 12.0;
    let a = saturation * min(lightness, 1.0 - lightness);
    return lightness - a * max(-1.0, min(k - 3.0, min(9.0 - k, 1.0)));
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let hsl = rgb_to_hsl(clamp(src.rgb, vec3f(0.0), vec3f(1.0)));
    // A 0.5 output is neutral. Hue changes by at most half a turn, saturation
    // scales from 0–2, and lightness shifts by at most half its range.
    let hue = fract(hsl.x + sample_curve(0u, hsl.x) - 0.5 + 1.0);
    let saturation = clamp(
        hsl.y * 2.0 * sample_curve(1u, hsl.x) * 2.0 * sample_curve(3u, hsl.z),
        0.0, 1.0,
    );
    let lightness = clamp(hsl.z + sample_curve(2u, hsl.x) - 0.5, 0.0, 1.0);
    return vec4f(
        hue_channel(hue, saturation, lightness, 0.0),
        hue_channel(hue, saturation, lightness, 8.0),
        hue_channel(hue, saturation, lightness, 4.0),
        src.a,
    );
}
