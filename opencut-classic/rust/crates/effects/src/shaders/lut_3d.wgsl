// 3D colour LUT application (COL-008). The parsed `.cube` table is uploaded as
// a `texture_3d<f32>` and sampled with linear filtering, so the hardware does
// the trilinear interpolation — the same result as the CPU reference sampler in
// `effects/luts/sample-cube-lut.ts`, without hand-rolling the eight-corner
// blend in the shader.
//
// Sampling maps a colour in [0, 1] onto texel *centres*: a `size`-node axis has
// its first node at texel centre 0.5/size and its last at (size-0.5)/size, so
// the coordinate is `(c * (size - 1) + 0.5) / size`. Skipping that half-texel
// offset would sample between nodes and wash the grade out at the extremes.
//
// The RGBA8 table is encoded with per-channel output ranges and decoded after
// sampling. `intensity` then blends the full graded value toward the source,
// including LUT outputs outside [0, 1].

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct LutParams {
    // intensity, size, _, _
    scalars: vec4f,
    domain_min: vec4f,
    domain_max: vec4f,
    output_min: vec4f,
    output_max: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> u: LutParams;
@group(2) @binding(0) var lut_texture: texture_3d<f32>;
@group(2) @binding(1) var lut_sampler: sampler;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);

    let intensity = clamp(u.scalars.x, 0.0, 1.0);
    // A table needs at least two nodes per axis to interpolate between.
    let size = max(u.scalars.y, 2.0);

    let c = clamp((src.rgb - u.domain_min.rgb) / (u.domain_max.rgb - u.domain_min.rgb), vec3f(0.0), vec3f(1.0));
    let coords = (c * (size - 1.0) + vec3f(0.5)) / size;
    // RGBA8 stores each LUT channel in its own output range. Decode after
    // interpolation so values beyond [0, 1] survive partial intensity blends.
    let encoded = textureSample(lut_texture, lut_sampler, coords).rgb;
    let graded = u.output_min.rgb + encoded * (u.output_max.rgb - u.output_min.rgb);

    return vec4f(mix(src.rgb, graded, intensity), src.a);
}
