import { expect, test } from "bun:test";

// Load the package built from this checkout, rather than a published release.
const entry = new URL(
	"../../../../../rust/wasm/pkg/opencut_wasm.js",
	import.meta.url,
);
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

test("built WASM computes RGB parade and vectorscope from the same pixels", () => {
	const pixels = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]);
	const parade = glue.computeRgbParade(pixels, 2, 1, 2, 4);
	try {
		expect(parade.columns).toBe(2);
		expect(parade.bins).toBe(4);
		expect(parade.peak).toBe(1);
		expect(parade.counts[3]).toBe(1);
		expect(parade.counts[7]).toBe(1);
	} finally {
		parade.free();
	}

	const vectorscope = glue.computeVectorscope(pixels, 2, 1, 16);
	try {
		expect(vectorscope.size).toBe(16);
		expect(vectorscope.peak).toBe(2);
		expect(
			vectorscope.counts.reduce((sum: number, n: number) => sum + n, 0),
		).toBe(2);
	} finally {
		vectorscope.free();
	}
});
