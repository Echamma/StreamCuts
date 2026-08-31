import { describe, expect, mock, test } from "bun:test";

// element-groups uses `@/wasm` MediaTime arithmetic, whose wasm-bindgen binary
// cannot instantiate under `bun test`. Stub `@/wasm` with faithful pure
// implementations. `mock.module` is global for the run, so this is a COMPLETE
// superset of the media-time surface (mirroring the linked-elements suite) — an
// incomplete stub would leak a missing export into sibling files that load
// afterward.
const TPS = 120000;
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: TPS,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => {
		const rounded = Math.round(Math.abs(time));
		return rounded === 0 ? 0 : time < 0 ? -rounded : rounded;
	},
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
	clampMediaTime: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => (time < min ? min : time > max ? max : time),
	roundFrameTicks: ({
		ticks,
		fps,
	}: {
		ticks: number;
		fps: { numerator: number; denominator: number };
	}) => {
		const frame = (TPS * fps.denominator) / fps.numerator;
		return Math.round(ticks / frame) * frame;
	},
}));

const { mediaTime } = await import("@/wasm");
const {
	expandRefsWithGroups,
	getGroupedRefs,
	getSharedGroupId,
	isRefGrouped,
	propagateGroupMoves,
} = await import("@/timeline/element-groups");

type PlannedElementMove =
	import("@/timeline/group-move/types").PlannedElementMove;
type AudioElement = import("@/timeline/types").AudioElement;
type SceneTracks = import("@/timeline/types").SceneTracks;
type VideoElement = import("@/timeline/types").VideoElement;

const t = (ticks: number) => mediaTime({ ticks });

function video({
	id,
	startTime,
	groupId,
	linkId,
}: {
	id: string;
	startTime: number;
	groupId?: string;
	linkId?: string;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: `${id}-media`,
		duration: t(100),
		startTime: t(startTime),
		trimStart: t(0),
		trimEnd: t(0),
		params: {},
		groupId,
		linkId,
	};
}

function audio({
	id,
	startTime,
	groupId,
	linkId,
}: {
	id: string;
	startTime: number;
	groupId?: string;
	linkId?: string;
}): AudioElement {
	return {
		id,
		name: id,
		type: "audio",
		sourceType: "upload",
		mediaId: `${id}-media`,
		duration: t(100),
		startTime: t(startTime),
		trimStart: t(0),
		trimEnd: t(0),
		params: {},
		groupId,
		linkId,
	};
}

function tracksOf({
	videoElements,
	audioElements = [],
}: {
	videoElements: VideoElement[];
	audioElements?: AudioElement[];
}): SceneTracks {
	return {
		video: [
			{
				id: "v0",
				name: "V0",
				type: "video",
				muted: false,
				hidden: false,
				elements: videoElements,
			},
		],
		text: [],
		graphic: [],
		effect: [],
		audio: [
			{
				id: "a0",
				name: "A0",
				type: "audio",
				muted: false,
				elements: audioElements,
			},
		],
	};
}

function move({
	elementId,
	newStartTime,
	trackId = "v0",
}: {
	elementId: string;
	newStartTime: number;
	trackId?: string;
}): PlannedElementMove {
	return {
		sourceTrackId: trackId,
		targetTrackId: trackId,
		elementId,
		newStartTime: t(newStartTime),
	};
}

/** Group "G1" over two video clips, plus an ungrouped clip. */
function groupedTracks(): SceneTracks {
	return tracksOf({
		videoElements: [
			video({ id: "a", startTime: 100, groupId: "G1" }),
			video({ id: "b", startTime: 500, groupId: "G1" }),
			video({ id: "solo", startTime: 900 }),
		],
	});
}

/** Group "G1" over a/b, where b is also the video half of link "L1" with c. */
function groupWithLinkedPair(): SceneTracks {
	return tracksOf({
		videoElements: [
			video({ id: "a", startTime: 0, groupId: "G1" }),
			video({ id: "b", startTime: 0, groupId: "G1", linkId: "L1" }),
		],
		audioElements: [audio({ id: "c", startTime: 0, linkId: "L1" })],
	});
}

describe("getGroupedRefs", () => {
	test("returns the other members of a group", () => {
		const related = getGroupedRefs({
			tracks: groupedTracks(),
			refs: [{ trackId: "v0", elementId: "a" }],
		});
		expect(related).toEqual([{ trackId: "v0", elementId: "b" }]);
	});

	test("is empty for an ungrouped clip", () => {
		expect(
			getGroupedRefs({
				tracks: groupedTracks(),
				refs: [{ trackId: "v0", elementId: "solo" }],
			}),
		).toEqual([]);
	});

	test("closes transitively over a link inside the group", () => {
		// Selecting `a` must reach `c`: a—b by group, b—c by link.
		const related = getGroupedRefs({
			tracks: groupWithLinkedPair(),
			refs: [{ trackId: "v0", elementId: "a" }],
		});
		expect(related.map((ref) => ref.elementId).sort()).toEqual(["b", "c"]);
	});

	test("reaches the whole group when starting from a merely linked clip", () => {
		const related = getGroupedRefs({
			tracks: groupWithLinkedPair(),
			refs: [{ trackId: "a0", elementId: "c" }],
		});
		expect(related.map((ref) => ref.elementId).sort()).toEqual(["a", "b"]);
	});

	test("keeps distinct groups separate", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 0, groupId: "G1" }),
				video({ id: "b", startTime: 0, groupId: "G1" }),
				video({ id: "x", startTime: 0, groupId: "G2" }),
			],
		});
		const related = getGroupedRefs({
			tracks,
			refs: [{ trackId: "v0", elementId: "a" }],
		});
		expect(related.map((ref) => ref.elementId)).toEqual(["b"]);
	});

	test("members keep their own track id", () => {
		const related = getGroupedRefs({
			tracks: tracksOf({
				videoElements: [video({ id: "a", startTime: 0, groupId: "G1" })],
				audioElements: [audio({ id: "b", startTime: 0, groupId: "G1" })],
			}),
			refs: [{ trackId: "v0", elementId: "a" }],
		});
		expect(related).toEqual([{ trackId: "a0", elementId: "b" }]);
	});
});

describe("expandRefsWithGroups", () => {
	test("returns the input array itself when nothing is grouped", () => {
		const refs = [{ trackId: "v0", elementId: "solo" }];
		expect(expandRefsWithGroups({ tracks: groupedTracks(), refs })).toBe(refs);
	});

	test("appends relatives without duplicating an included member", () => {
		const expanded = expandRefsWithGroups({
			tracks: groupedTracks(),
			refs: [
				{ trackId: "v0", elementId: "a" },
				{ trackId: "v0", elementId: "b" },
			],
		});
		expect(expanded.map((ref) => ref.elementId)).toEqual(["a", "b"]);
	});
});

describe("propagateGroupMoves", () => {
	test("shifts group members by the same delta", () => {
		const moves = propagateGroupMoves({
			tracks: groupedTracks(),
			moves: [move({ elementId: "a", newStartTime: 150 })],
		});
		// `a` moved +50, so `b` must land at 550 on its own track.
		expect(moves).toHaveLength(2);
		expect(moves[1]).toEqual({
			sourceTrackId: "v0",
			targetTrackId: "v0",
			elementId: "b",
			newStartTime: t(550),
		});
	});

	test("carries a linked partner of a grouped clip too", () => {
		const moves = propagateGroupMoves({
			tracks: groupWithLinkedPair(),
			moves: [move({ elementId: "a", newStartTime: 60 })],
		});
		expect(moves.map((m) => m.elementId).sort()).toEqual(["a", "b", "c"]);
		expect(moves.find((m) => m.elementId === "c")?.newStartTime).toBe(t(60));
	});

	test("clamps a relative to zero rather than a negative start", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 100, groupId: "G1" }),
				video({ id: "b", startTime: 20, groupId: "G1" }),
			],
		});
		const moves = propagateGroupMoves({
			tracks,
			moves: [move({ elementId: "a", newStartTime: 0 })],
		});
		expect(moves[1]?.newStartTime).toBe(t(0));
	});

	test("an explicit move of a relative wins over propagation", () => {
		const moves = propagateGroupMoves({
			tracks: groupedTracks(),
			moves: [
				move({ elementId: "a", newStartTime: 150 }),
				move({ elementId: "b", newStartTime: 999 }),
			],
		});
		expect(moves).toHaveLength(2);
		expect(moves.find((m) => m.elementId === "b")?.newStartTime).toBe(t(999));
	});

	test("is an identity when nothing moving is grouped", () => {
		const moves = [move({ elementId: "solo", newStartTime: 50 })];
		expect(propagateGroupMoves({ tracks: groupedTracks(), moves })).toBe(moves);
	});

	test("a zero delta generates nothing", () => {
		const moves = [move({ elementId: "a", newStartTime: 100 })];
		expect(propagateGroupMoves({ tracks: groupedTracks(), moves })).toBe(moves);
	});
});

describe("isRefGrouped", () => {
	test("true for a grouped clip, false for an ungrouped one", () => {
		const tracks = groupedTracks();
		expect(isRefGrouped({ tracks, ref: { trackId: "v0", elementId: "a" } })).toBe(
			true,
		);
		expect(
			isRefGrouped({ tracks, ref: { trackId: "v0", elementId: "solo" } }),
		).toBe(false);
	});

	test("a merely linked clip is not grouped", () => {
		expect(
			isRefGrouped({
				tracks: groupWithLinkedPair(),
				ref: { trackId: "a0", elementId: "c" },
			}),
		).toBe(false);
	});
});

describe("getSharedGroupId", () => {
	test("returns the id when every ref is in the same group", () => {
		expect(
			getSharedGroupId({
				tracks: groupedTracks(),
				refs: [
					{ trackId: "v0", elementId: "a" },
					{ trackId: "v0", elementId: "b" },
				],
			}),
		).toBe("G1");
	});

	test("null when the selection spans groups or includes a loose clip", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 0, groupId: "G1" }),
				video({ id: "x", startTime: 0, groupId: "G2" }),
				video({ id: "solo", startTime: 0 }),
			],
		});
		expect(
			getSharedGroupId({
				tracks,
				refs: [
					{ trackId: "v0", elementId: "a" },
					{ trackId: "v0", elementId: "x" },
				],
			}),
		).toBeNull();
		expect(
			getSharedGroupId({
				tracks,
				refs: [
					{ trackId: "v0", elementId: "a" },
					{ trackId: "v0", elementId: "solo" },
				],
			}),
		).toBeNull();
	});
});
