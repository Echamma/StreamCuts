import { describe, expect, mock, test } from "bun:test";

// linked-elements uses `@/wasm` MediaTime arithmetic, whose wasm-bindgen binary
// cannot instantiate under `bun test`. Stub `@/wasm` with faithful pure
// implementations. `mock.module` is global for the run, so this is a COMPLETE
// superset of the media-time surface (mirroring the trim suite) — an incomplete
// stub would leak a missing export into sibling files that load afterward.
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
	expandRefsWithLinked,
	getLinkedRefs,
	isRefLinked,
	propagateLinkedMoves,
} = await import("@/timeline/linked-elements");

type PlannedElementMove =
	import("@/timeline/group-move/types").PlannedElementMove;
type AudioElement = import("@/timeline/types").AudioElement;
type SceneTracks = import("@/timeline/types").SceneTracks;
type VideoElement = import("@/timeline/types").VideoElement;

const t = (ticks: number) => mediaTime({ ticks });

function video({
	id,
	startTime,
	linkId,
}: {
	id: string;
	startTime: number;
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
		linkId,
	};
}

function audio({
	id,
	startTime,
	linkId,
}: {
	id: string;
	startTime: number;
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
		linkId,
	};
}

// A linked A/V pair (link "L1") on v0/a0, plus an unlinked clip on v0.
function makeTracks(): SceneTracks {
	return {
		video: [
			{
				id: "v0",
				name: "V0",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					video({ id: "vid", startTime: 50, linkId: "L1" }),
					video({ id: "solo", startTime: 400 }),
				],
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
				elements: [audio({ id: "aud", startTime: 50, linkId: "L1" })],
			},
		],
	};
}

describe("getLinkedRefs", () => {
	test("returns the linked sibling, excluding the input ref", () => {
		const linked = getLinkedRefs({
			tracks: makeTracks(),
			refs: [{ trackId: "v0", elementId: "vid" }],
		});
		expect(linked).toEqual([{ trackId: "a0", elementId: "aud" }]);
	});

	test("empty for an unlinked ref", () => {
		expect(
			getLinkedRefs({
				tracks: makeTracks(),
				refs: [{ trackId: "v0", elementId: "solo" }],
			}),
		).toEqual([]);
	});

	test("does not re-list a sibling already present in the input", () => {
		const linked = getLinkedRefs({
			tracks: makeTracks(),
			refs: [
				{ trackId: "v0", elementId: "vid" },
				{ trackId: "a0", elementId: "aud" },
			],
		});
		expect(linked).toEqual([]);
	});
});

describe("expandRefsWithLinked", () => {
	test("adds the linked sibling to the acted-on set", () => {
		const expanded = expandRefsWithLinked({
			tracks: makeTracks(),
			refs: [{ trackId: "v0", elementId: "vid" }],
		});
		expect(expanded.map((r) => r.elementId).sort()).toEqual(["aud", "vid"]);
	});

	test("returns input untouched when nothing is linked", () => {
		const refs = [{ trackId: "v0", elementId: "solo" }];
		expect(expandRefsWithLinked({ tracks: makeTracks(), refs })).toBe(refs);
	});
});

describe("propagateLinkedMoves", () => {
	test("shifts the linked sibling by the same delta on its own track", () => {
		const moves: PlannedElementMove[] = [
			{
				sourceTrackId: "v0",
				targetTrackId: "v0",
				elementId: "vid",
				newStartTime: t(90), // +40 from 50
			},
		];
		const propagated = propagateLinkedMoves({ tracks: makeTracks(), moves });
		expect(propagated).toHaveLength(2);
		const sibling = propagated.find((m) => m.elementId === "aud");
		expect(sibling).toEqual({
			sourceTrackId: "a0",
			targetTrackId: "a0",
			elementId: "aud",
			newStartTime: t(90), // 50 + 40
		});
	});

	test("does not override a sibling already moved explicitly", () => {
		const moves: PlannedElementMove[] = [
			{
				sourceTrackId: "v0",
				targetTrackId: "v0",
				elementId: "vid",
				newStartTime: t(90),
			},
			{
				sourceTrackId: "a0",
				targetTrackId: "a0",
				elementId: "aud",
				newStartTime: t(200),
			},
		];
		const propagated = propagateLinkedMoves({ tracks: makeTracks(), moves });
		expect(propagated).toHaveLength(2);
		expect(propagated.find((m) => m.elementId === "aud")?.newStartTime).toBe(
			t(200),
		);
	});

	test("clamps a leftward propagation to zero, never negative", () => {
		const moves: PlannedElementMove[] = [
			{
				sourceTrackId: "v0",
				targetTrackId: "v0",
				elementId: "vid",
				newStartTime: t(0), // -50 delta; sibling at 50 would land at 0
			},
		];
		const propagated = propagateLinkedMoves({ tracks: makeTracks(), moves });
		expect(propagated.find((m) => m.elementId === "aud")?.newStartTime).toBe(
			t(0),
		);
	});

	test("no-op when the moving element is unlinked", () => {
		const moves: PlannedElementMove[] = [
			{
				sourceTrackId: "v0",
				targetTrackId: "v0",
				elementId: "solo",
				newStartTime: t(500),
			},
		];
		const propagated = propagateLinkedMoves({ tracks: makeTracks(), moves });
		expect(propagated).toBe(moves);
	});

	test("empty moves returned as-is", () => {
		const moves: PlannedElementMove[] = [];
		expect(propagateLinkedMoves({ tracks: makeTracks(), moves })).toBe(moves);
	});
});

describe("isRefLinked", () => {
	test("true for a linked element, false for an unlinked one", () => {
		const tracks = makeTracks();
		expect(isRefLinked({ tracks, ref: { trackId: "v0", elementId: "vid" } })).toBe(
			true,
		);
		expect(
			isRefLinked({ tracks, ref: { trackId: "v0", elementId: "solo" } }),
		).toBe(false);
	});
});
