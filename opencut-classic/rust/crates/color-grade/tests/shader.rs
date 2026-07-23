//! Static validation of the color-wheels WGSL shader (COL-002). The shader is
//! normally only checked when the GPU device creates the module at runtime;
//! this parses + validates it with naga so a syntax or type slip fails the test
//! suite instead of silently breaking the effect in the browser.

const COLOR_WHEELS_WGSL: &str =
    include_str!("../../effects/src/shaders/color_wheels.wgsl");

#[test]
fn color_wheels_wgsl_parses_and_validates() {
    let module = naga::front::wgsl::parse_str(COLOR_WHEELS_WGSL)
        .unwrap_or_else(|error| panic!("WGSL parse error:\n{}", error.emit_to_string(COLOR_WHEELS_WGSL)));

    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    validator
        .validate(&module)
        .unwrap_or_else(|error| panic!("WGSL validation error: {error:?}"));
}
