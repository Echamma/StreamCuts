import { describe, expect, mock, test } from "bun:test";

// compound-clips uses `@/wasm` MediaTime arithmetic, whose wasm-bindgen binary
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
	decomposeCompound,
	measureCompoundDuration,
	planCompound,
} = await import("@/timeline/compound-clips");

type AudioElement = import("@/timeline/types").AudioElement;
type SceneTracks = import("@/timeline/types").SceneTracks;
type VideoElement = import("@/timeline/types").VideoElement;

const t = (ticks: number) => mediaTime({ ticks });

function video({
	id,
	startTime,
	duration = 100,
}: {
	id: string;
	startTime: number;
	duration?: number;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: `${id}-media`,
		duration: t(duration),
		startTime: t(startTime),
		trimStart: t(0),
		trimEnd: t(0),
		params: {},
	};
}

function audio({
	id,
	startTime,
	duration = 100,
}: {
	id: string;
	startTime: number;
	duration?: number;
}): AudioElement {
	return {
		id,
		name: id,
		type: "audio",
		sourceType: "upload",
		mediaId: `${id}-media`,
		duration: t(duration),
		startTime: t(startTime),
		trimStart: t(0),
		trimEnd: t(0),
		params: {},
	};
}

function tracksOf({
	videoElements = [],
	audioElements = [],
}: {
	videoElements?: VideoElement[];
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

const refOf = ({ trackId, elementId }: { trackId: string; elementId: string }) => ({
	trackId,
	elementId,
});

describe("planCompound", () => {
	test("spans from the earliest start to the latest end", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 200, duration: 100 }),
				video({ id: "b", startTime: 500, duration: 250 }),
			],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		expect(plan?.startTime).toBe(t(200));
		// latest end is 500 + 250 = 750, so the span is 750 - 200.
		expect(plan?.content.duration).toBe(t(550));
	});

	test("rebases children relative to the compound start, preserving gaps", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 200 }),
				video({ id: "b", startTime: 500 }),
			],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		const starts = plan?.content.tracks.video[0]?.elements.map(
			(element) => element.startTime,
		);
		// The 300-tick gap between them survives the fold.
		expect(starts).toEqual([t(0), t(300)]);
	});

	test("keeps children on their own track across buckets", () => {
		const tracks = tracksOf({
			videoElements: [video({ id: "v", startTime: 0 })],
			audioElements: [audio({ id: "a", startTime: 0 })],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "v" }),
				refOf({ trackId: "a0", elementId: "a" }),
			],
		});
		expect(plan?.content.tracks.video[0]?.elements.map((e) => e.id)).toEqual(["v"]);
		expect(plan?.content.tracks.audio[0]?.elements.map((e) => e.id)).toEqual(["a"]);
	});

	test("drops tracks that contributed nothing", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 0 }),
				video({ id: "b", startTime: 200 }),
			],
			audioElements: [audio({ id: "untouched", startTime: 0 })],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		expect(plan?.content.tracks.audio).toEqual([]);
	});

	test("reports exactly the refs it consumed", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 0 }),
				video({ id: "b", startTime: 200 }),
				video({ id: "left-alone", startTime: 900 }),
			],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		expect(plan?.sourceRefs.map((ref) => ref.elementId)).toEqual(["a", "b"]);
	});

	test("refuses a selection of fewer than two elements", () => {
		const tracks = tracksOf({ videoElements: [video({ id: "a", startTime: 0 })] });
		expect(
			planCompound({
				tracks,
				refs: [refOf({ trackId: "v0", elementId: "a" })],
			}),
		).toBeNull();
		expect(planCompound({ tracks, refs: [] })).toBeNull();
	});

	test("ignores refs that match no element", () => {
		const tracks = tracksOf({ videoElements: [video({ id: "a", startTime: 0 })] });
		expect(
			planCompound({
				tracks,
				refs: [
					refOf({ trackId: "v0", elementId: "a" }),
					refOf({ trackId: "v0", elementId: "ghost" }),
				],
			}),
		).toBeNull();
	});
});

describe("decomposeCompound", () => {
	test("round-trips: folding then unfolding restores the originals", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 200, duration: 100 }),
				video({ id: "b", startTime: 500, duration: 250 }),
			],
			audioElements: [audio({ id: "c", startTime: 300 })],
		});
		const refs = [
			refOf({ trackId: "v0", elementId: "a" }),
			refOf({ trackId: "v0", elementId: "b" }),
			refOf({ trackId: "a0", elementId: "c" }),
		];
		const plan = planCompound({ tracks, refs });
		expect(plan).not.toBeNull();
		if (!plan) return;

		const restored = decomposeCompound({
			content: plan.content,
			startTime: plan.startTime,
		});
		const byId = new Map(restored.map((r) => [r.element.id, r]));
		expect(byId.get("a")?.element.startTime).toBe(t(200));
		expect(byId.get("b")?.element.startTime).toBe(t(500));
		expect(byId.get("c")?.element.startTime).toBe(t(300));
		// ...and each lands back on the track it came from.
		expect(byId.get("a")?.trackId).toBe("v0");
		expect(byId.get("c")?.trackId).toBe("a0");
	});

	test("unfolding at a new start shifts the whole contents rigidly", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 200 }),
				video({ id: "b", startTime: 500 }),
			],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		if (!plan) throw new Error("expected a plan");

		// Move the compound to 1000: children keep their 300-tick spacing.
		const restored = decomposeCompound({
			content: plan.content,
			startTime: t(1000),
		});
		expect(restored.map((r) => r.element.startTime)).toEqual([t(1000), t(1300)]);
	});

	test("clamps a child that would land before zero", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 100 }),
				video({ id: "b", startTime: 400 }),
			],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		if (!plan) throw new Error("expected a plan");

		const restored = decomposeCompound({
			content: plan.content,
			startTime: t(-50),
		});
		expect(restored[0]?.element.startTime).toBe(t(0));
	});
});

describe("measureCompoundDuration", () => {
	test("reports the latest child end", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 0, duration: 100 }),
				video({ id: "b", startTime: 300, duration: 250 }),
			],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		if (!plan) throw new Error("expected a plan");
		expect(measureCompoundDuration({ content: plan.content })).toBe(t(550));
	});

	test("an empty compound measures zero", () => {
		expect(
			measureCompoundDuration({
				content: { tracks: tracksOf({}), duration: t(0) },
			}),
		).toBe(t(0));
	});

	test("re-measuring catches a child extended past the folded duration", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 0, duration: 100 }),
				video({ id: "b", startTime: 100, duration: 100 }),
			],
		});
		const plan = planCompound({
			tracks,
			refs: [
				refOf({ trackId: "v0", elementId: "a" }),
				refOf({ trackId: "v0", elementId: "b" }),
			],
		});
		if (!plan) throw new Error("expected a plan");
		expect(plan.content.duration).toBe(t(200));

		// Simulate editing inside the compound: stretch the last child.
		const stretched = {
			...plan.content,
			tracks: {
				...plan.content.tracks,
				video: plan.content.tracks.video.map((track) => ({
					...track,
					elements: track.elements.map((element) =>
						element.id === "b"
							? { ...element, duration: t(400) }
							: element,
					),
				})),
			},
		};
		expect(measureCompoundDuration({ content: stretched })).toBe(t(500));
	});
});
