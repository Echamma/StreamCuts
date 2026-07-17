import { describe, expect, test } from "bun:test";
import {
	clampFadeSeconds,
	computeFadeGain,
	FADE_MAX_SECONDS,
} from "@/timeline/audio-fade";

// The math is pure and has no `@/wasm` dependency, so no mock is needed.

describe("clampFadeSeconds", () => {
	test("passes through legal values", () => {
		expect(clampFadeSeconds({ value: 0 })).toBe(0);
		expect(clampFadeSeconds({ value: 1.5 })).toBe(1.5);
	});

	test("clamps negative to zero", () => {
		expect(clampFadeSeconds({ value: -1 })).toBe(0);
	});

	test("clamps above the practical cap", () => {
		expect(clampFadeSeconds({ value: 1000 })).toBe(FADE_MAX_SECONDS);
	});

	test("non-finite falls back to zero", () => {
		expect(clampFadeSeconds({ value: Number.NaN })).toBe(0);
		expect(clampFadeSeconds({ value: Number.POSITIVE_INFINITY })).toBe(0);
	});
});

describe("computeFadeGain", () => {
	test("no-fade clip: constant unity across the visible span", () => {
		const args = { fadeIn: 0, fadeOut: 0, duration: 3 };
		expect(computeFadeGain({ ...args, localTime: 0 })).toBe(1);
		expect(computeFadeGain({ ...args, localTime: 1.5 })).toBe(1);
		expect(computeFadeGain({ ...args, localTime: 3 })).toBe(1);
	});

	test("fade-in: linear ramp from 0 to 1 over fadeIn seconds", () => {
		const args = { fadeIn: 1, fadeOut: 0, duration: 3 };
		expect(computeFadeGain({ ...args, localTime: 0 })).toBe(0);
		expect(computeFadeGain({ ...args, localTime: 0.25 })).toBeCloseTo(0.25, 10);
		expect(computeFadeGain({ ...args, localTime: 0.5 })).toBeCloseTo(0.5, 10);
		expect(computeFadeGain({ ...args, localTime: 1 })).toBe(1);
		expect(computeFadeGain({ ...args, localTime: 2 })).toBe(1);
	});

	test("fade-out: linear ramp from 1 to 0 over fadeOut seconds", () => {
		const args = { fadeIn: 0, fadeOut: 1, duration: 3 };
		expect(computeFadeGain({ ...args, localTime: 0 })).toBe(1);
		expect(computeFadeGain({ ...args, localTime: 1.99 })).toBeCloseTo(1, 2);
		expect(computeFadeGain({ ...args, localTime: 2 })).toBe(1);
		expect(computeFadeGain({ ...args, localTime: 2.5 })).toBeCloseTo(0.5, 10);
		expect(computeFadeGain({ ...args, localTime: 3 })).toBe(0);
	});

	test("both fades non-overlapping", () => {
		const args = { fadeIn: 0.5, fadeOut: 0.5, duration: 4 };
		expect(computeFadeGain({ ...args, localTime: 0.25 })).toBeCloseTo(0.5, 10);
		expect(computeFadeGain({ ...args, localTime: 2 })).toBe(1);
		expect(computeFadeGain({ ...args, localTime: 3.75 })).toBeCloseTo(0.5, 10);
	});

	test("overlapping fades never exceed unity (taking min of attack/release)", () => {
		const args = { fadeIn: 2, fadeOut: 2, duration: 3 };
		// At the midpoint, attack = 1.5/2 = 0.75, release = 1.5/2 = 0.75 → 0.75
		expect(computeFadeGain({ ...args, localTime: 1.5 })).toBeCloseTo(0.75, 10);
		// Attack passes 1 before duration/2; release is dominant later
		expect(computeFadeGain({ ...args, localTime: 0.5 })).toBeCloseTo(0.25, 10);
		expect(computeFadeGain({ ...args, localTime: 2.5 })).toBeCloseTo(0.25, 10);
	});

	test("out-of-window times read as silence", () => {
		const args = { fadeIn: 0.5, fadeOut: 0.5, duration: 3 };
		expect(computeFadeGain({ ...args, localTime: -0.001 })).toBe(0);
		expect(computeFadeGain({ ...args, localTime: 3.001 })).toBe(0);
	});

	test("zero-duration clip is silent", () => {
		expect(
			computeFadeGain({ fadeIn: 0, fadeOut: 0, duration: 0, localTime: 0 }),
		).toBe(0);
	});
});
