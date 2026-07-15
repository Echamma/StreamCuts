import { describe, expect, test } from "bun:test";
import type { Bookmark } from "@/timeline";
import {
	formatMarkerTime,
	markerLabel,
	sortBookmarksByTime,
} from "@/timeline/bookmarks/marker-list";

// marker-list.ts has only a type-only import, so this runs without stubbing
// @/wasm. MediaTime is a bare number at runtime, so plain ints stand in for it.
function bm({ time, note }: { time: number; note?: string }): Bookmark {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: MediaTime is a bare number at runtime
	return { time, note } as unknown as Bookmark;
}

describe("sortBookmarksByTime", () => {
	test("orders by time ascending without mutating the input", () => {
		const input = [bm({ time: 30 }), bm({ time: 10 }), bm({ time: 20 })];
		const sorted = sortBookmarksByTime({ bookmarks: input });
		expect(sorted.map((b) => b.time)).toEqual([10, 20, 30]);
		// original order preserved (non-mutating)
		expect(input.map((b) => b.time)).toEqual([30, 10, 20]);
	});

	test("handles empty and single-element lists", () => {
		expect(sortBookmarksByTime({ bookmarks: [] })).toEqual([]);
		expect(
			sortBookmarksByTime({ bookmarks: [bm({ time: 5 })] }).map((b) => b.time),
		).toEqual([5]);
	});
});

describe("formatMarkerTime", () => {
	test("formats minutes, seconds and tenths", () => {
		expect(formatMarkerTime({ seconds: 0 })).toBe("0:00.0");
		expect(formatMarkerTime({ seconds: 5.4 })).toBe("0:05.4");
		expect(formatMarkerTime({ seconds: 65.9 })).toBe("1:05.9");
		expect(formatMarkerTime({ seconds: 600 })).toBe("10:00.0");
	});

	test("clamps non-finite or negative input to zero", () => {
		expect(formatMarkerTime({ seconds: -3 })).toBe("0:00.0");
		expect(formatMarkerTime({ seconds: Number.NaN })).toBe("0:00.0");
	});
});

describe("markerLabel", () => {
	test("uses the note when present", () => {
		expect(markerLabel({ bookmark: bm({ time: 0, note: "Intro" }) })).toBe(
			"Intro",
		);
	});

	test("falls back to 'Marker' for empty or whitespace notes", () => {
		expect(markerLabel({ bookmark: bm({ time: 0 }) })).toBe("Marker");
		expect(markerLabel({ bookmark: bm({ time: 0, note: "   " }) })).toBe(
			"Marker",
		);
	});
});
