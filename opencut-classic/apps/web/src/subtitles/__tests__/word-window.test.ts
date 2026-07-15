import { describe, expect, test } from "bun:test";
import {
	computeActiveWord,
	resolveEvenSplitWindows,
	resolveWordWindows,
} from "@/subtitles/animation/word-window";

describe("resolveEvenSplitWindows", () => {
	test("splits a duration into back-to-back equal windows", () => {
		const windows = resolveEvenSplitWindows({
			wordCount: 4,
			durationSeconds: 4,
		});
		expect(windows).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
			{ start: 2, end: 3 },
			{ start: 3, end: 4 },
		]);
	});

	test("returns an empty list for zero words", () => {
		expect(
			resolveEvenSplitWindows({ wordCount: 0, durationSeconds: 4 }),
		).toEqual([]);
	});
});

describe("resolveWordWindows", () => {
	const realWords = [
		{ start: 0.0, end: 0.4 },
		{ start: 0.6, end: 1.0 },
	];

	test("prefers real timings when the count matches", () => {
		expect(
			resolveWordWindows({
				wordCount: 2,
				durationSeconds: 1,
				words: realWords,
			}),
		).toEqual([
			{ start: 0.0, end: 0.4 },
			{ start: 0.6, end: 1.0 },
		]);
	});

	test("falls back to even split when the count mismatches", () => {
		expect(
			resolveWordWindows({
				wordCount: 2,
				durationSeconds: 2,
				words: [{ start: 0, end: 1 }],
			}),
		).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
		]);
	});

	test("falls back to even split when no real timings are given", () => {
		expect(
			resolveWordWindows({ wordCount: 2, durationSeconds: 2 }),
		).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
		]);
	});
});

describe("computeActiveWord", () => {
	// Real timings with a gap between word 1 and word 2.
	const windows = [
		{ start: 0.0, end: 0.4 },
		{ start: 0.4, end: 0.8 },
		{ start: 1.0, end: 1.4 },
	];

	test("nothing active before the first word", () => {
		expect(computeActiveWord({ windows, currentTime: -0.1 })).toEqual({
			containedIndex: -1,
			lastStartedIndex: -1,
			currentIndex: -1,
		});
	});

	test("first word active at its start (half-open)", () => {
		expect(computeActiveWord({ windows, currentTime: 0 })).toEqual({
			containedIndex: 0,
			lastStartedIndex: 0,
			currentIndex: 0,
		});
	});

	test("boundary belongs to the next word", () => {
		expect(computeActiveWord({ windows, currentTime: 0.4 })).toEqual({
			containedIndex: 1,
			lastStartedIndex: 1,
			currentIndex: 1,
		});
	});

	test("in a gap, current falls back to the last started word", () => {
		// 0.9s is after word 1 ends (0.8) and before word 2 starts (1.0).
		expect(computeActiveWord({ windows, currentTime: 0.9 })).toEqual({
			containedIndex: -1,
			lastStartedIndex: 1,
			currentIndex: 1,
		});
	});

	test("past the end, current sticks to the final word", () => {
		expect(computeActiveWord({ windows, currentTime: 5 })).toEqual({
			containedIndex: -1,
			lastStartedIndex: 2,
			currentIndex: 2,
		});
	});
});
