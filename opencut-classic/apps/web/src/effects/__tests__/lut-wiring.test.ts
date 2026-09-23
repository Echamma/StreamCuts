import { expect, mock, test } from "bun:test";

// wasm-pack emits bundler glue. Instantiate its real binary explicitly for Bun;
// the module alias below supplies real Rust exports, not a math mock.
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

const { prepareLut, IDENTITY_CURVES, readCurvePoints } =
	await import("../luts/prepared-lut");
const { lutEffectDefinition } = await import("../definitions/lut");
const { curvesEffectDefinition } = await import("../definitions/curves");
const { parseCubeLut } = await import("../luts/cube-lut");
const { sampleToneCurve } = await import("../curves/tone-curve");
const { prepareExactCurves } = await import("../curves/prepared-curves");
const inverted =
	"LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0";

test("Rust import matches the reference parser and reuses a prepared table", () => {
	const first = prepareLut({ kind: "cube", source: inverted });
	expect(first.error).toBeUndefined();
	expect(first.value?.uniforms.lutTable).toEqual(
		Array.from(parseCubeLut({ text: inverted }).table),
	);
	expect(prepareLut({ kind: "cube", source: inverted })).toBe(first);
});

test("LUT passes carry domain and intensity; zero and missing LUT are neutral", () => {
	const build = lutEffectDefinition.renderer.buildPasses!;
	const passes = build({
		effectParams: { cube: inverted + "\nDOMAIN_MAX 2 2 2", intensity: 0.5 },
		width: 320,
		height: 180,
	});
	expect(passes[0].shader).toBe("lut-3d");
	expect(passes[0].uniforms.domainMax).toEqual([2, 2, 2]);
	expect(passes[0].uniforms.intensity).toBe(0.5);
	expect(
		build({
			effectParams: { cube: inverted, intensity: 0 },
			width: 1,
			height: 1,
		}),
	).toEqual([]);
	expect(build({ effectParams: {}, width: 1, height: 1 })).toEqual([]);
});

test("invalid imported or saved data reports an error without crashing the renderer", () => {
	expect(
		prepareLut({ kind: "cube", source: "LUT_3D_SIZE 2\nNaN 0 0" }).error,
	).toBeTruthy();
	expect(prepareLut({ kind: "curves", source: "invalid" }).error).toBeTruthy();
	expect(
		curvesEffectDefinition.renderer.buildPasses!({
			effectParams: { curves: "invalid" },
			width: 1,
			height: 1,
		}),
	).toEqual([]);
});

test("Rust curve bake agrees with the CPU reference at lattice nodes", () => {
	const curves = readCurvePoints(IDENTITY_CURVES);
	curves[0] = [
		[0, 0],
		[0.5, 0.75],
		[1, 1],
	];
	const prepared = prepareLut({
		kind: "curves",
		source: JSON.stringify(curves),
	});
	const table = prepared.value?.uniforms.lutTable;
	if (!Array.isArray(table)) throw new Error("Missing baked table");
	const reference = sampleToneCurve({
		points: curves[0].map(([x, y]) => ({ x, y })),
		size: 33,
	});
	for (let r = 0; r < 33; r++)
		expect(table[r * 3]).toBeCloseTo(reference[r], 5);
	expect(
		curvesEffectDefinition.renderer.buildPasses!({
			effectParams: {},
			width: 1,
			height: 1,
		}),
	).toEqual([]);
});

test("steep curves keep their exact control points in the GPU pass", () => {
	const curves = readCurvePoints(IDENTITY_CURVES);
	curves[0] = [
		[0, 0],
		[0.5, 0],
		[0.51, 1],
		[1, 1],
	];
	const source = JSON.stringify(curves);
	const prepared = prepareExactCurves(source);
	expect(prepared.error).toBeUndefined();
	expect(prepareExactCurves(source)).toBe(prepared);
	const pass = curvesEffectDefinition.renderer.buildPasses!({
		effectParams: { curves: source },
		width: 1,
		height: 1,
	})[0];
	expect(pass.shader).toBe("tone-curves");
	expect(pass.uniforms.curveCounts).toEqual([4, 2, 2, 2]);
	const nodes = pass.uniforms.curveNodes;
	if (!Array.isArray(nodes)) throw new Error("Missing analytic curve nodes");
	expect(nodes).toHaveLength(512);
	expect(nodes.slice(4, 7)).toEqual([0.5, 0, 0]);
	expect(nodes[8]).toBeCloseTo(0.51, 6);
	expect(nodes[9]).toBe(1);
	expect(pass.uniforms).not.toHaveProperty("lutTable");
});

test("content cache stays correct after eviction", () => {
	for (let i = 0; i < 12; i++)
		prepareLut({ kind: "cube", source: `TITLE "${i}"\n${inverted}` });
	expect(
		prepareLut({ kind: "cube", source: inverted }).value?.uniforms.lutSize,
	).toBe(2);
});
