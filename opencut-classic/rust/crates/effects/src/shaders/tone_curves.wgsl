// Analytic monotone cubic tone curves. The control points and tangents are
// computed by color_grade::lut::prepare_curves; evaluating the same cubic per
// pixel avoids interpolation error from a coarse 3D LUT at narrow transitions.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct CurveParams {
    // Master, red, green, blue point counts, each in [2, 32].
    counts: vec4f,
    // Four 32-lane blocks. A lane is (x, y, tangent, padding).
    nodes: array<vec4f, 128>,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> u: CurveParams;

fn evaluate_curve(channel: u32, x: f32) -> f32 {
    let base = channel * 32u;
    let count = u32(u.counts[channel]);
    let first = u.nodes[base];
    if (x <= first.x) {
        return first.y;
    }
    let last = u.nodes[base + count - 1u];
    if (x >= last.x) {
        return last.y;
    }

    var lo_index = 0u;
    var hi_index = count - 1u;
    loop {
        if (hi_index - lo_index <= 1u) {
            break;
        }
        let mid = (lo_index + hi_index) / 2u;
        if (u.nodes[base + mid].x <= x) {
            lo_index = mid;
        } else {
            hi_index = mid;
        }
    }
    let lo = u.nodes[base + lo_index];
    let hi = u.nodes[base + hi_index];
    let h = hi.x - lo.x;
    let t = (x - lo.x) / h;
    let t2 = t * t;
    let t3 = t2 * t;
    return clamp(
        (2.0 * t3 - 3.0 * t2 + 1.0) * lo.y
            + (t3 - 2.0 * t2 + t) * h * lo.z
            + (-2.0 * t3 + 3.0 * t2) * hi.y
            + (t3 - t2) * h * hi.z,
        0.0,
        1.0,
    );
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let master = vec3f(
        evaluate_curve(0u, src.r),
        evaluate_curve(0u, src.g),
        evaluate_curve(0u, src.b),
    );
    return vec4f(
        evaluate_curve(1u, master.r),
        evaluate_curve(2u, master.g),
        evaluate_curve(3u, master.b),
        src.a,
    );
}
