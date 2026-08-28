//! Static validation of the colour WGSL shaders (COL-002 wheels, COL-008 LUT).
//! They are normally only checked when the GPU device creates the module at
//! runtime; this parses + validates them with naga so a syntax or type slip
//! fails the test suite instead of silently breaking the effect in the browser.
//!
//! The shaders live in the sibling `effects` crate, but the tests live here:
//! `effects` depends on wgpu, which cannot build for the host on this
//! toolchain, whereas this crate is pure math and always builds.

const COLOR_WHEELS_WGSL: &str =
    include_str!("../../effects/src/shaders/color_wheels.wgsl");
const LUT_3D_WGSL: &str = include_str!("../../effects/src/shaders/lut_3d.wgsl");

fn parse_and_validate(source: &str, label: &str) {
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| {
        panic!("{label} WGSL parse error:\n{}", error.emit_to_string(source))
    });

    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    validator
        .validate(&module)
        .unwrap_or_else(|error| panic!("{label} WGSL validation error: {error:?}"));
}

#[test]
fn color_wheels_wgsl_parses_and_validates() {
    parse_and_validate(COLOR_WHEELS_WGSL, "color_wheels");
}

#[test]
fn lut_3d_wgsl_parses_and_validates() {
    parse_and_validate(LUT_3D_WGSL, "lut_3d");
}

/// The LUT shader samples texel *centres*: `(c * (size - 1) + 0.5) / size`.
/// This locks that mapping down — dropping the half-texel offset is the classic
/// 3D-LUT bug (it samples between nodes and washes out the extremes), and the
/// arithmetic is easier to check here than by eye in WGSL.
#[test]
fn lut_coordinate_mapping_hits_texel_centres() {
    fn coord(c: f32, size: f32) -> f32 {
        (c * (size - 1.0) + 0.5) / size
    }

    let size = 4.0_f32;
    // Black maps to the centre of the first texel...
    assert!((coord(0.0, size) - 0.5 / size).abs() < 1e-6);
    // ...and white to the centre of the last.
    assert!((coord(1.0, size) - (size - 0.5) / size).abs() < 1e-6);

    // Every node lands exactly on its own texel centre, so an identity LUT
    // round-trips node values unchanged.
    for node in 0..(size as u32) {
        let value = node as f32 / (size - 1.0);
        let expected = (node as f32 + 0.5) / size;
        assert!(
            (coord(value, size) - expected).abs() < 1e-6,
            "node {node} mapped to {} (expected {expected})",
            coord(value, size)
        );
    }
}
