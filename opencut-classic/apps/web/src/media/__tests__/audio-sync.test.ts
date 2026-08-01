import { describe, expect, test } from "bun:test";
import {
	estimateSyncOffsetFromSummaries,
	estimateSyncOffsetSamples,
	estimateSyncOffsetSeconds,
	planClipSyncStart,
	resampleEnvelope,
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

describe("resampleEnvelope", () => {
	test("same rate returns a copy", () => {
		const envelope = [1, 2, 3, 4];
		const out = resampleEnvelope({ envelope, fromRate: 10, toRate: 10 });
		expect(out).toEqual(envelope);
		expect(out).not.toBe(envelope);
	});

	test("halving the rate roughly halves the length", () => {
		const out = resampleEnvelope({
			envelope: [0, 1, 2, 3, 4, 5, 6, 7],
			fromRate: 8,
			toRate: 4,
		});
		expect(out.length).toBe(4);
		// srcPos = j * 2 → exact source samples, no interpolation.
		expect(out).toEqual([0, 2, 4, 6]);
	});

	test("linearly interpolates between buckets when upsampling", () => {
		const out = resampleEnvelope({
			envelope: [0, 10],
			fromRate: 1,
			toRate: 2,
		});
		// srcPos = j * 0.5 → 0, 0.5, 1, 1.5 → 0, 5, 10, 10 (last clamps).
		expect(out).toEqual([0, 5, 10, 10]);
	});

	test("rejects non-positive rates", () => {
		expect(() =>
			resampleEnvelope({ envelope: [1], fromRate: 0, toRate: 1 }),
		).toThrow("rates must be positive");
	});
});

describe("estimateSyncOffsetFromSummaries", () => {
	test("recovers an offset across differing bucket rates", () => {
		// Reference at 100 buckets/s (sampleRate 4800, bucketSize 48).
		const reference = envelope(40);
		// Same content sampled twice as coarse — 50 buckets/s — and delayed 0.2s.
		const delayed = shiftRight({ arr: reference, k: 20 });
		const coarse = resampleEnvelope({
			envelope: delayed,
			fromRate: 100,
			toRate: 50,
		});
		const { offsetSeconds, score } = estimateSyncOffsetFromSummaries({
			reference: { amplitudes: reference, sampleRate: 4800, bucketSize: 48 },
			target: { amplitudes: coarse, sampleRate: 4800, bucketSize: 96 },
			maxLagSeconds: 1,
		});
		// 20 buckets at 100/s = 0.2s delay; correlation on the common 50/s grid.
		expect(offsetSeconds).toBeCloseTo(0.2, 1);
		expect(score).toBeGreaterThan(0.9);
	});

	test("degenerate envelopes yield a zero, low-confidence result", () => {
		const result = estimateSyncOffsetFromSummaries({
			reference: { amplitudes: [1], sampleRate: 48000, bucketSize: 128 },
			target: { amplitudes: [], sampleRate: 48000, bucketSize: 128 },
		});
		expect(result).toEqual({ offsetSeconds: 0, score: 0 });
	});
});

describe("planClipSyncStart", () => {
	test("shifts the target earlier by a positive content offset", () => {
		const { targetTimelineStartSeconds } = planClipSyncStart({
			referenceTimelineStartSeconds: 10,
			referenceTrimStartSeconds: 0,
			targetTrimStartSeconds: 0,
			offsetSeconds: 2,
		});
		expect(targetTimelineStartSeconds).toBe(8);
	});

	test("accounts for both clips' trim offsets", () => {
		// Reference shows source from 5s at timeline 10s; target from 0s; the
		// shared event is 2s later in the target source.
		const { targetTimelineStartSeconds } = planClipSyncStart({
			referenceTimelineStartSeconds: 10,
			referenceTrimStartSeconds: 5,
			targetTrimStartSeconds: 0,
			offsetSeconds: 2,
		});
		expect(targetTimelineStartSeconds).toBe(3);
	});

	test("can return a negative start (target would precede the origin)", () => {
		const { targetTimelineStartSeconds } = planClipSyncStart({
			referenceTimelineStartSeconds: 1,
			referenceTrimStartSeconds: 0,
			targetTrimStartSeconds: 0,
			offsetSeconds: 4,
		});
		expect(targetTimelineStartSeconds).toBe(-3);
	});
});
