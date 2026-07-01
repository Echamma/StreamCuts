import { describe, expect, test } from "bun:test";
import {
	findActiveWord,
	findLastWordIndexActivated,
} from "@/subtitles/animation/word-active";
import type { CaptionCueWithWords } from "@/subtitles/animation/types";

const cue: CaptionCueWithWords = {
	startTime: 1.0,
	endTime: 4.0,
	words: [
		{ text: "hello", start: 1.0, end: 1.5 },
		{ text: "there", start: 1.5, end: 2.0 },
		{ text: "world", start: 2.0, end: 4.0 },
	],
};

describe("findActiveWord — half-open boundary [start, end)", () => {
	test("returns null before the cue starts", () => {
		expect(findActiveWord({ cue, timeSeconds: 0.5 })).toBeNull();
	});

	test("returns null at the cue's end timestamp", () => {
		// 4.0 is the end of the cue → no longer active.
		expect(findActiveWord({ cue, timeSeconds: 4.0 })).toBeNull();
	});

	test("returns the first word at the cue's start timestamp", () => {
		const hit = findActiveWord({ cue, timeSeconds: 1.0 });
		expect(hit?.word.text).toBe("hello");
		expect(hit?.index).toBe(0);
	});

	test("transitions to the next word exactly at the boundary timestamp", () => {
		// 1.5 is the boundary between hello and there. With [start, end) we
		// expect "there" to claim it — not "hello".
		const hit = findActiveWord({ cue, timeSeconds: 1.5 });
		expect(hit?.word.text).toBe("there");
		expect(hit?.index).toBe(1);
	});

	test("returns the last word inside its window", () => {
		const hit = findActiveWord({ cue, timeSeconds: 3.999 });
		expect(hit?.word.text).toBe("world");
		expect(hit?.index).toBe(2);
	});
});

describe("findLastWordIndexActivated — typewriter accumulation", () => {
	test("-1 before the cue starts", () => {
		expect(findLastWordIndexActivated({ cue, timeSeconds: 0 })).toBe(-1);
	});

	test("0 once the first word activates", () => {
		expect(findLastWordIndexActivated({ cue, timeSeconds: 1.0 })).toBe(0);
	});

	test("does not advance until the next word's start timestamp", () => {
		expect(findLastWordIndexActivated({ cue, timeSeconds: 1.499 })).toBe(0);
		expect(findLastWordIndexActivated({ cue, timeSeconds: 1.5 })).toBe(1);
	});

	test("remains at the last word after its end timestamp", () => {
		// Typewriter keeps prior words visible; we return the last activated
		// index even past the active word's end.
		expect(findLastWordIndexActivated({ cue, timeSeconds: 5.0 })).toBe(2);
	});

	test("handles empty word list", () => {
		expect(
			findLastWordIndexActivated({
				cue: { startTime: 0, endTime: 1, words: [] },
				timeSeconds: 0.5,
			}),
		).toBe(-1);
	});
});
