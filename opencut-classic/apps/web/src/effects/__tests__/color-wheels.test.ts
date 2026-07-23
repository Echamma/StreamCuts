import { describe, expect, test } from "bun:test";
import type { ParamValues } from "@/params";
import {
	buildColorWheelsPasses,
	colorGradeUniforms,
	COLOR_WHEELS_SHADER,
	isIdentityColorGrade,
	readColorGradeParams,
} from "@/effects/definitions/color-wheels";

// Pure module: only type-only imports, so no @/wasm mock is needed.

describe("readColorGradeParams", () => {
	test("empty params resolve to the identity grade", () => {
		const values = readColorGradeParams({});
		expect(values.lift).toEqual({ r: 0, g: 0, b: 0, master: 0 });
		expect(values.gamma).toEqual({ r: 1, g: 1, b: 1, master: 0 });
		expect(values.gain).toEqual({ r: 1, g: 1, b: 1, master: 0 });
		expect(values.contrast).toBe(1);
		expect(values.pivot).toBe(0.5);
		expect(values.saturation).toBe(1);
	});

	test("reads overrides by key", () => {
		const params: ParamValues = {
			lift_r: 0.1,
			gain_master: -0.2,
			saturation: 1.5,
			hue: 45,
		};
		const values = readColorGradeParams(params);
		expect(values.lift.r).toBe(0.1);
		expect(values.gain.master).toBe(-0.2);
		expect(values.saturation).toBe(1.5);
		expect(values.hue).toBe(45);
	});
});

describe("isIdentityColorGrade", () => {
	test("default params are identity", () => {
		expect(isIdentityColorGrade(readColorGradeParams({}))).toBe(true);
	});

	test("pivot alone does not break identity (no effect at contrast 1)", () => {
		expect(isIdentityColorGrade(readColorGradeParams({ pivot: 0.3 }))).toBe(true);
	});

	test("any real adjustment is not identity", () => {
		expect(isIdentityColorGrade(readColorGradeParams({ contrast: 1.2 }))).toBe(false);
		expect(isIdentityColorGrade(readColorGradeParams({ lift_b: 0.05 }))).toBe(false);
		expect(isIdentityColorGrade(readColorGradeParams({ hue: 10 }))).toBe(false);
	});
});

describe("colorGradeUniforms", () => {
	test("maps wheels to vec3 + master scalar and passes scalars through", () => {
		const uniforms = colorGradeUniforms(
			readColorGradeParams({
				lift_r: 0.1,
				lift_g: 0.2,
				lift_b: 0.3,
				lift_master: 0.4,
				contrast: 1.3,
			}),
		);
		expect(uniforms.u_lift).toEqual([0.1, 0.2, 0.3]);
		expect(uniforms.u_lift_master).toBe(0.4);
		expect(uniforms.u_contrast).toBe(1.3);
		// gamma/gain default to 1s.
		expect(uniforms.u_gamma).toEqual([1, 1, 1]);
		expect(uniforms.u_gain).toEqual([1, 1, 1]);
	});
});

describe("buildColorWheelsPasses", () => {
	test("identity grade emits zero passes (no GPU work)", () => {
		expect(buildColorWheelsPasses({ effectParams: {} })).toEqual([]);
		expect(buildColorWheelsPasses({ effectParams: { pivot: 0.2 } })).toEqual([]);
	});

	test("a real grade emits one color-wheels pass", () => {
		const passes = buildColorWheelsPasses({ effectParams: { saturation: 1.4 } });
		expect(passes).toHaveLength(1);
		expect(passes[0].shader).toBe(COLOR_WHEELS_SHADER);
		expect(passes[0].uniforms.u_saturation).toBe(1.4);
	});
});
