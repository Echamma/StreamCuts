import { expect, mock, test } from "bun:test";

// Exercise the real Rust/WASM curve preparation used by both preview and export.
const entry = new URL(
	"../../../../../rust/wasm/pkg/opencut_wasm.js",
	import.meta.url,
).href;
const glue = await import(new URL("./opencut_wasm_bg.js", entry).href);
const bytes = await Bun.file(
	new URL("./opencut_wasm_bg.wasm", entry),
).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, {
	"./opencut_wasm_bg.js": glue,
});
glue.__wbg_set_wasm(instance.exports);
const start = instance.exports.__wbindgen_start;
if (typeof start === "function") start();
mock.module("opencut-wasm", () => glue);

const { IDENTITY_HSL_CURVES, prepareHslCurvePass } =
	await import("../curves/prepared-hsl-curves");
const { hslCurvesEffectDefinition } = await import("../definitions/hsl-curves");

test("neutral HSL curves omit the GPU pass", () => {
	expect(
		hslCurvesEffectDefinition.renderer.buildPasses!({
			effectParams: { hslCurves: IDENTITY_HSL_CURVES },
			width: 64,
			height: 64,
		}),
	).toEqual([]);
});

test("a hue edit creates one 256-entry, four-lane GPU table", () => {
	const points = JSON.parse(IDENTITY_HSL_CURVES);
	points[0] = [
		[0, 0.5 + 1 / 3],
		[1, 0.5 + 1 / 3],
	];
	const source = JSON.stringify(points);
	const first = prepareHslCurvePass(source);
	expect(first.error).toBeUndefined();
	expect(prepareHslCurvePass(source)).toBe(first);
	const passes = hslCurvesEffectDefinition.renderer.buildPasses!({
		effectParams: { hslCurves: source },
		width: 64,
		height: 64,
	});
	expect(passes).toHaveLength(1);
	expect(passes[0].shader).toBe("hsl-curves");
	const table = passes[0].uniforms.curveTable as number[];
	expect(table).toHaveLength(1024);
	expect(table[0]).toBeCloseTo(0.5 + 1 / 3, 5);
	expect(table[1]).toBe(0.5);
});

test("hue endpoints must join at the seam", () => {
	const points = JSON.parse(IDENTITY_HSL_CURVES);
	points[1] = [
		[0, 0.25],
		[1, 0.75],
	];
	expect(prepareHslCurvePass(JSON.stringify(points)).error).toContain(
		"matching values",
	);
});
