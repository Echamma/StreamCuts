import { describe, expect, test } from "bun:test";
import {
	estimateSyncOffsetSamples,
	estimateSyncOffsetSeconds,
} from "@/media/audio-sync";

// audio-sync.ts is pure (no @/wasm), so no stub is needed.

/** A deterministic, aperiodic envelope (LCG) — a unique cross-correlation peak. */
function envelope(length: number): number[] {
	let seed = 12345;
	return Array.from({ length }, () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % 100;
	});
}

/** `arr` delayed by `k` samples (shifted right, zero-padded). */
function shiftRight({ arr, k }: { arr: number[]; k: number }): number[] {
	return arr.map((_, i) => (i - k >= 0 ? arr[i - k] : 0));
}

/** `arr` advanced by `k` samples (shifted left, zero-padded). */
function shiftLeft({ arr, k }: { arr: number[]; k: number }): number[] {
	return arr.map((_, i) => (i + k < arr.length ? arr[i + k] : 0));
}

describe("estimateSyncOffsetSamples", () => {
	test("recovers a positive delay (target later)", () => {
		const reference = envelope(30);
		const target = shiftRight({ arr: reference, k: 2 });
		const { offsetSamples, score } = estimateSyncOffsetSamples({
			reference,
			target,
			maxLagSamples: 6,
		});
		expect(offsetSamples).toBe(2);
		expect(score).toBeCloseTo(1, 5);
	});

	test("recovers a negative offset (target earlier)", () => {
		const reference = envelope(30);
		const target = shiftLeft({ arr: reference, k: 3 });
		expect(
			estimateSyncOffsetSamples({ reference, target, maxLagSamples: 6 })
				.offsetSamples,
		).toBe(-3);
	});

	test("identical envelopes align at zero", () => {
		const reference = envelope(24);
		const { offsetSamples, score } = estimateSyncOffsetSamples({
			reference,
			target: [...reference],
		});
		expect(offsetSamples).toBe(0);
		expect(score).toBeCloseTo(1, 5);
	});

	test("respects the maxLagSamples search bound", () => {
		const reference = envelope(30);
		const target = shiftRight({ arr: reference, k: 5 });
		// True offset is 5 but the search is capped at 2 — it can't report beyond.
		const { offsetSamples } = estimateSyncOffsetSamples({
			reference,
			target,
			maxLagSamples: 2,
		});
		expect(Math.abs(offsetSamples)).toBeLessThanOrEqual(2);
	});
});

describe("estimateSyncOffsetSeconds", () => {
	test("converts the sample offset by the envelope rate", () => {
		const reference = envelope(30);
		const target = shiftRight({ arr: reference, k: 2 });
		const { offsetSeconds } = estimateSyncOffsetSeconds({
			reference,
			target,
			samplesPerSecond: 10,
			maxLagSeconds: 1,
		});
		expect(offsetSeconds).toBeCloseTo(0.2, 6);
	});

	test("rejects a non-positive sample rate", () => {
		expect(() =>
			estimateSyncOffsetSeconds({
				reference: [1, 2, 3],
				target: [1, 2, 3],
				samplesPerSecond: 0,
			}),
		).toThrow("samplesPerSecond must be positive");
	});
});
