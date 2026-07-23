import { describe, expect, test } from "bun:test";
import {
	computeHistogram,
	computeWaveform,
	type ScopeSample,
} from "@/scopes/scope-math";

function makeSample({
	rgb,
	width = 4,
	height = 4,
}: {
	rgb: [number, number, number];
	width?: number;
	height?: number;
}): ScopeSample {
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		pixels[i * 4] = rgb[0];
		pixels[i * 4 + 1] = rgb[1];
		pixels[i * 4 + 2] = rgb[2];
		pixels[i * 4 + 3] = 255;
	}
	return { pixels, width, height };
}

describe("computeWaveform", () => {
	test("all-black frame lands in the lowest luma bin", () => {
		const { counts, columns, lumaBins, peak } = computeWaveform({
			sample: makeSample({ rgb: [0, 0, 0], width: 8, height: 8 }),
			columns: 8,
			lumaBins: 64,
		});

		expect(columns).toBe(8);
		expect(lumaBins).toBe(64);
		expect(peak).toBe(8); // 8 rows per column
		// every column has 8 hits in bin 0, nothing elsewhere
		for (let c = 0; c < 8; c++) {
			expect(counts[c * 64 + 0]).toBe(8);
			for (let bin = 1; bin < 64; bin++) {
				expect(counts[c * 64 + bin]).toBe(0);
			}
		}
	});

	test("all-white frame lands in the highest luma bin", () => {
		const { counts, lumaBins } = computeWaveform({
			sample: makeSample({ rgb: [255, 255, 255], width: 4, height: 4 }),
			columns: 4,
			lumaBins: 32,
		});

		for (let c = 0; c < 4; c++) {
			expect(counts[c * lumaBins + (lumaBins - 1)]).toBe(4);
			expect(counts[c * lumaBins + 0]).toBe(0);
		}
	});

	test("empty sample returns a zero result rather than throwing", () => {
		const empty: ScopeSample = {
			pixels: new Uint8ClampedArray(0),
			width: 0,
			height: 0,
		};
		const { counts, peak } = computeWaveform({
			sample: empty,
			columns: 4,
			lumaBins: 8,
		});
		expect(peak).toBe(0);
		expect(counts.every((v) => v === 0)).toBe(true);
	});

	test("rejects nonsensical bin counts", () => {
		const sample = makeSample({ rgb: [0, 0, 0] });
		expect(() =>
			computeWaveform({ sample, columns: 0, lumaBins: 8 }),
		).toThrow();
		expect(() =>
			computeWaveform({ sample, columns: 8, lumaBins: 0 }),
		).toThrow();
	});
});

describe("computeHistogram", () => {
	test("solid red frame fills only red-255, green-0, blue-0", () => {
		const { red, green, blue, luma, peak } = computeHistogram({
			sample: makeSample({ rgb: [255, 0, 0], width: 4, height: 4 }),
		});
		const total = 4 * 4;
		expect(red[255]).toBe(total);
		expect(red[0]).toBe(0);
		expect(green[0]).toBe(total);
		expect(green[255]).toBe(0);
		expect(blue[0]).toBe(total);
		// luma of pure red ≈ 0.2126 * 255 = 54.2 → rounds to 54
		expect(luma[54]).toBe(total);
		expect(peak).toBe(total);
	});

	test("empty sample stays zero-valued", () => {
		const { red, peak } = computeHistogram({
			sample: { pixels: new Uint8ClampedArray(0), width: 0, height: 0 },
		});
		expect(peak).toBe(0);
		expect(red.every((v) => v === 0)).toBe(true);
	});

	test("bin counts sum to the pixel count across each channel", () => {
		const width = 3;
		const height = 3;
		const pixels = new Uint8ClampedArray(width * height * 4);
		// nine unique values 0,32,64,...,255 (approximately)
		for (let i = 0; i < 9; i++) {
			const v = Math.floor((i / 8) * 255);
			pixels[i * 4] = v;
			pixels[i * 4 + 1] = v;
			pixels[i * 4 + 2] = v;
			pixels[i * 4 + 3] = 255;
		}
		const { red, green, blue, luma } = computeHistogram({
			sample: { pixels, width, height },
		});
		const total = width * height;
		const sum = (a: Uint32Array): number => a.reduce((acc, v) => acc + v, 0);
		expect(sum(red)).toBe(total);
		expect(sum(green)).toBe(total);
		expect(sum(blue)).toBe(total);
		expect(sum(luma)).toBe(total);
	});
});
