import { describe, expect, test } from "bun:test";
import type { AudioCapableElement } from "@/timeline/audio-state";
import {
	biquadCoefficients,
	biquadFrequencyResponseDb,
	EQ_DEFAULT_MID_FREQUENCY,
	EQ_DEFAULT_Q,
	isEqFlat,
	processBiquad,
	processEqChain,
	resolveElementEqBands,
	type EqBand,
} from "@/timeline/audio-eq";

// audio-eq.ts imports only a type, so no @/wasm stub is needed. The band
// resolver reads only `params`, so a bare params bag stands in for an element.
function elementWith(
	params: Record<string, number | string | boolean>,
): AudioCapableElement {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: only params is read
	return { params } as AudioCapableElement;
}

const SAMPLE_RATE = 48000;

function responseAt({
	type,
	frequency,
	gainDb,
	q,
	at,
}: {
	type: EqBand["type"];
	frequency: number;
	gainDb: number;
	q: number;
	at: number;
}): number {
	return biquadFrequencyResponseDb({
		coefficients: biquadCoefficients({
			type,
			sampleRate: SAMPLE_RATE,
			frequency,
			gainDb,
			q,
		}),
		frequency: at,
		sampleRate: SAMPLE_RATE,
	});
}

describe("biquadCoefficients / frequency response", () => {
	test("a 0 dB band is flat everywhere (exact bypass)", () => {
		for (const at of [50, 500, 5000, 20000]) {
			expect(
				responseAt({ type: "peaking", frequency: 1000, gainDb: 0, q: 1, at }),
			).toBeCloseTo(0, 6);
		}
	});

	test("peaking hits exactly its gain at the centre frequency", () => {
		expect(
			responseAt({ type: "peaking", frequency: 1000, gainDb: 6, q: 1, at: 1000 }),
		).toBeCloseTo(6, 4);
	});

	test("peaking decays away from the centre frequency", () => {
		expect(
			responseAt({ type: "peaking", frequency: 1000, gainDb: 6, q: 1, at: 60 }),
		).toBeCloseTo(0, 1);
		expect(
			responseAt({
				type: "peaking",
				frequency: 1000,
				gainDb: 6,
				q: 1,
				at: 18000,
			}),
		).toBeCloseTo(0, 1);
	});

	test("low shelf boosts the low end, leaves the top flat", () => {
		expect(
			responseAt({ type: "lowshelf", frequency: 120, gainDb: 6, q: 1, at: 20 }),
		).toBeCloseTo(6, 1);
		expect(
			responseAt({
				type: "lowshelf",
				frequency: 120,
				gainDb: 6,
				q: 1,
				at: 18000,
			}),
		).toBeCloseTo(0, 1);
	});

	test("high shelf boosts the top, leaves the low end flat", () => {
		expect(
			responseAt({
				type: "highshelf",
				frequency: 12000,
				gainDb: 6,
				q: 1,
				at: 21000,
			}),
		).toBeCloseTo(6, 1);
		expect(
			responseAt({ type: "highshelf", frequency: 12000, gainDb: 6, q: 1, at: 40 }),
		).toBeCloseTo(0, 1);
	});

	test("negative gain cuts (low shelf at DC)", () => {
		expect(
			responseAt({ type: "lowshelf", frequency: 120, gainDb: -6, q: 1, at: 10 }),
		).toBeCloseTo(-6, 1);
	});
});

describe("processBiquad", () => {
	test("a 0 dB peaking filter passes samples through unchanged", () => {
		const input = new Float32Array([0.1, -0.4, 0.9, -0.2, 0.05, 0.7, -1, 0.3]);
		const output = processBiquad({
			coefficients: biquadCoefficients({
				type: "peaking",
				sampleRate: SAMPLE_RATE,
				frequency: 1000,
				gainDb: 0,
				q: 1,
			}),
			samples: input,
		});
		for (let i = 0; i < input.length; i++) {
			expect(output[i]).toBeCloseTo(input[i], 6);
		}
	});

	test("DC steady-state gain of a +6 dB low shelf is the linear gain", () => {
		// A constant (DC) input settles to H(z=1) = 10^(dB/20) for a shelf.
		const input = new Float32Array(4096).fill(1);
		const output = processBiquad({
			coefficients: biquadCoefficients({
				type: "lowshelf",
				sampleRate: SAMPLE_RATE,
				frequency: 120,
				gainDb: 6,
				q: 1,
			}),
			samples: input,
		});
		expect(output[output.length - 1]).toBeCloseTo(Math.pow(10, 6 / 20), 3);
	});
});

describe("processEqChain", () => {
	test("all-flat bands are a true no-op (returns the same array)", () => {
		const samples = new Float32Array([0.2, -0.5, 0.8]);
		const result = processEqChain({
			bands: resolveElementEqBands({ element: elementWith({}) }),
			sampleRate: SAMPLE_RATE,
			samples,
		});
		expect(result).toBe(samples);
	});

	test("a boosted band changes the signal", () => {
		const samples = new Float32Array(256).fill(0).map((_, i) => Math.sin(i / 4));
		const bands: EqBand[] = [
			{ type: "peaking", frequency: 1000, gainDb: 9, q: 1 },
		];
		const result = processEqChain({ bands, sampleRate: SAMPLE_RATE, samples });
		expect(result).not.toBe(samples);
		let changed = false;
		for (let i = 0; i < samples.length; i++) {
			if (Math.abs(result[i] - samples[i]) > 1e-6) {
				changed = true;
				break;
			}
		}
		expect(changed).toBe(true);
	});
});

describe("resolveElementEqBands / isEqFlat", () => {
	test("no EQ params yields a flat, bypassed 3-band EQ", () => {
		const bands = resolveElementEqBands({ element: elementWith({}) });
		expect(bands.map((b) => b.type)).toEqual([
			"lowshelf",
			"peaking",
			"highshelf",
		]);
		expect(bands[1].frequency).toBe(EQ_DEFAULT_MID_FREQUENCY);
		expect(bands[1].q).toBe(EQ_DEFAULT_Q);
		expect(isEqFlat({ bands })).toBe(true);
	});

	test("reads gains, mid frequency and Q from params", () => {
		const bands = resolveElementEqBands({
			element: elementWith({
				eqLowGainDb: -3,
				eqMidGainDb: 4,
				eqMidFrequency: 2500,
				eqMidQ: 2,
				eqHighGainDb: 5,
			}),
		});
		expect(bands[0].gainDb).toBe(-3);
		expect(bands[1].gainDb).toBe(4);
		expect(bands[1].frequency).toBe(2500);
		expect(bands[1].q).toBe(2);
		expect(bands[2].gainDb).toBe(5);
		expect(isEqFlat({ bands })).toBe(false);
	});

	test("non-finite params fall back to defaults", () => {
		const bands = resolveElementEqBands({
			element: elementWith({ eqMidFrequency: Number.NaN }),
		});
		expect(bands[1].frequency).toBe(EQ_DEFAULT_MID_FREQUENCY);
	});
});
