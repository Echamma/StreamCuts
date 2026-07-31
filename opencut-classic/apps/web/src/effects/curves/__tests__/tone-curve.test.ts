import { describe, expect, test } from "bun:test";
import {
	evaluateToneCurve,
	prepareToneCurve,
	sampleToneCurve,
	type CurvePoint,
} from "@/effects/curves/tone-curve";

// tone-curve.ts is pure math — no @/wasm.

function evalAt({ points, x }: { points: CurvePoint[]; x: number }): number {
	return evaluateToneCurve({ curve: prepareToneCurve({ points }), x });
}

describe("tone curve — basics", () => {
	const identity: CurvePoint[] = [
		{ x: 0, y: 0 },
		{ x: 1, y: 1 },
	];

	test("identity curve returns the input", () => {
		for (const x of [0, 0.25, 0.5, 0.75, 1]) {
			expect(evalAt({ points: identity, x })).toBeCloseTo(x, 6);
		}
	});

	test("passes exactly through its control points", () => {
		const points: CurvePoint[] = [
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.7 },
			{ x: 1, y: 1 },
		];
		expect(evalAt({ points, x: 0 })).toBeCloseTo(0, 6);
		expect(evalAt({ points, x: 0.5 })).toBeCloseTo(0.7, 6);
		expect(evalAt({ points, x: 1 })).toBeCloseTo(1, 6);
	});

	test("clamps to the endpoints outside the domain", () => {
		const points: CurvePoint[] = [
			{ x: 0.2, y: 0.1 },
			{ x: 0.8, y: 0.9 },
		];
		expect(evalAt({ points, x: 0 })).toBeCloseTo(0.1, 6);
		expect(evalAt({ points, x: 1 })).toBeCloseTo(0.9, 6);
	});

	test("unsorted / duplicate points are handled", () => {
		const points: CurvePoint[] = [
			{ x: 1, y: 1 },
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.5 },
			{ x: 0.5, y: 0.9 }, // duplicate x — dropped
		];
		expect(evalAt({ points, x: 0.5 })).toBeCloseTo(0.5, 6);
	});
});

describe("tone curve — monotonicity (no overshoot)", () => {
	test("a lifted-mids curve stays monotonic and in range", () => {
		// A classic S-ish lift that would overshoot with a plain cubic spline.
		const points: CurvePoint[] = [
			{ x: 0, y: 0 },
			{ x: 0.25, y: 0.15 },
			{ x: 0.3, y: 0.75 },
			{ x: 0.75, y: 0.85 },
			{ x: 1, y: 1 },
		];
		const lut = sampleToneCurve({ points, size: 256 });
		let previous = -Infinity;
		for (const value of lut) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(1);
			expect(value).toBeGreaterThanOrEqual(previous - 1e-6); // non-decreasing
			previous = value;
		}
	});
});

describe("sampleToneCurve", () => {
	test("produces a LUT of the requested size, identity ≈ ramp", () => {
		const lut = sampleToneCurve({
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			],
			size: 5,
		});
		expect(lut).toHaveLength(5);
		expect(Array.from(lut)).toEqual([0, 0.25, 0.5, 0.75, 1]);
	});

	test("rejects a size below 2", () => {
		expect(() =>
			sampleToneCurve({ points: [{ x: 0, y: 0 }], size: 1 }),
		).toThrow("size must be >= 2");
	});
});
