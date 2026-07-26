import { describe, expect, test } from "bun:test";
import {
	filterUnlockedRefs,
	isTrackLocked,
	isTrackLockedById,
} from "@/timeline/track-lock";
import type { SceneTracks } from "@/timeline";

// Minimal SceneTracks — only the fields the lock helpers read.
function makeTracks(): SceneTracks {
	return {
		video: [
			{ id: "v0", name: "V0", type: "video", elements: [], muted: false, hidden: false },
			{ id: "v1", name: "V1", type: "video", elements: [], muted: false, hidden: false, locked: true },
		],
		text: [{ id: "t0", name: "T0", type: "text", elements: [], hidden: false }],
		graphic: [],
		effect: [],
		audio: [
			{ id: "a0", name: "A0", type: "audio", elements: [], muted: false, locked: true },
		],
	};
}

describe("isTrackLocked", () => {
	test("true only when locked === true", () => {
		expect(isTrackLocked({ track: { locked: true } })).toBe(true);
		expect(isTrackLocked({ track: { locked: false } })).toBe(false);
		expect(isTrackLocked({ track: {} })).toBe(false);
	});
});

describe("isTrackLockedById", () => {
	test("reflects the track's lock state across bands", () => {
		const tracks = makeTracks();
		expect(isTrackLockedById({ tracks, trackId: "v0" })).toBe(false);
		expect(isTrackLockedById({ tracks, trackId: "v1" })).toBe(true);
		expect(isTrackLockedById({ tracks, trackId: "a0" })).toBe(true);
		expect(isTrackLockedById({ tracks, trackId: "t0" })).toBe(false);
	});

	test("missing track is treated as unlocked", () => {
		expect(
			isTrackLockedById({ tracks: makeTracks(), trackId: "nope" }),
		).toBe(false);
	});
});

describe("filterUnlockedRefs", () => {
	test("drops refs on locked tracks, keeps the rest", () => {
		const tracks = makeTracks();
		const refs = [
			{ trackId: "v0", elementId: "e1" },
			{ trackId: "v1", elementId: "e2" }, // locked
			{ trackId: "a0", elementId: "e3" }, // locked
			{ trackId: "t0", elementId: "e4" },
		];
		const kept = filterUnlockedRefs({ tracks, refs });
		expect(kept.map((r) => r.elementId)).toEqual(["e1", "e4"]);
	});
});
