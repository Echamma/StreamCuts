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
	decomposeCompoundInTracks,
	cloneCompoundTracks,
	makeCompoundInTracks,
	measureCompoundDuration,
	planCompound,
} = await import("@/timeline/compound-clips");
const { flattenAudioElements } = await import("@/timeline/compound-audio");
const { getCompoundPath, replaceCompoundPath } = await import("@/timeline/compound-navigation");
const { stripAudioBuffersFromTracks } = await import("@/timeline/compound-storage");

type AudioElement = import("@/timeline/types").AudioElement;
type SceneTracks = import("@/timeline/types").SceneTracks;
type VideoElement = import("@/timeline/types").VideoElement;
type CompoundElement = import("@/timeline/types").CompoundElement;

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

describe("compound integration arithmetic", () => {
	test("fold/decompose restores clips and keeps internal transitions scoped", () => {
		const tracks = tracksOf({
			videoElements: [
				video({ id: "a", startTime: 0 }),
				video({ id: "b", startTime: 100 }),
			],
		});
		tracks.video[0].transitions = [{
			id: "transition",
			type: "fade",
			fromElementId: "a",
			toElementId: "b",
			duration: t(20),
			enabled: true,
		}];
		const folded = makeCompoundInTracks({
			tracks,
			refs: [refOf({ trackId: "v0", elementId: "a" }), refOf({ trackId: "v0", elementId: "b" })],
			id: "compound",
			trackId: "compound-track",
			name: "Compound",
		});
		expect(folded?.tracks.video[0].elements).toEqual([]);
		expect(folded?.tracks.video[0].transitions).toEqual([]);
		expect(folded?.compound.tracks.video[0].transitions).toHaveLength(1);
		if (!folded) throw new Error("expected fold");
		const unfolded = decomposeCompoundInTracks({
			tracks: folded.tracks,
			trackId: folded.trackId,
			elementId: folded.compound.id,
		});
		expect(unfolded?.video[0].elements.map(({ id }) => id)).toEqual(["a", "b"]);
		expect(unfolded?.video[0].transitions?.[0]?.fromElementId).toBe("a");
	});

	test("decompose keeps only a trimmed compound's visible source interval", () => {
		const content = tracksOf({
			videoElements: [video({ id: "a", startTime: 0, duration: 3 * TPS })],
		});
		const restored = decomposeCompound({
			content: { tracks: content, duration: t(3 * TPS) },
			startTime: t(5 * TPS),
			trimStart: t(TPS),
			duration: t(2 * TPS),
		});
		expect(restored[0]?.element.startTime).toBe(t(5 * TPS));
		expect(restored[0]?.element.duration).toBe(t(2 * TPS));
		expect(restored[0]?.element.trimStart).toBe(t(TPS));
	});

	test("copying a compound remaps child and transition ids", () => {
		const tracks = tracksOf({
			videoElements: [video({ id: "a", startTime: 0 }), video({ id: "b", startTime: 100 })],
		});
		tracks.video[0].transitions = [{
			id: "tr", type: "fade", fromElementId: "a", toElementId: "b", duration: t(20), enabled: true,
		}];
		let next = 0;
		const copied = cloneCompoundTracks({ tracks, generateId: () => `new-${++next}` });
		const [a, b] = copied.video[0].elements;
		expect(a.id).not.toBe("a");
		expect(b.id).not.toBe("b");
		expect(copied.video[0].transitions?.[0]?.fromElementId).toBe(a.id);
		expect(copied.video[0].transitions?.[0]?.toElementId).toBe(b.id);
	});

	test("nested audio uses compound-local time and the visible window", () => {
		const content = tracksOf({ audioElements: [audio({ id: "sound", startTime: 0, duration: 3 * TPS })] });
		const compound: CompoundElement = {
			id: "compound", name: "Compound", type: "compound", tracks: content,
			startTime: t(5 * TPS), duration: t(2 * TPS), trimStart: t(TPS),
			trimEnd: t(0), params: {},
		};
		const scene = tracksOf({});
		scene.video[0].elements.push(compound);
		const entries = flattenAudioElements({ tracks: scene });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			startTime: t(5 * TPS), duration: t(2 * TPS),
			trimStart: t(TPS), localOffset: t(TPS), trackMuted: false,
		});
		scene.video[0].muted = true;
		expect(flattenAudioElements({ tracks: scene })[0].trackMuted).toBe(true);
	});

	test("cycle guard stops recursive compounds", () => {
		const scene = tracksOf({});
		const compound: CompoundElement = {
			id: "self", name: "Self", type: "compound", tracks: tracksOf({}),
			startTime: t(0), duration: t(TPS), trimStart: t(0), trimEnd: t(0), params: {},
		};
		compound.tracks.video[0].elements.push(compound);
		scene.video[0].elements.push(compound);
		expect(flattenAudioElements({ tracks: scene })).toEqual([]);
		expect(getCompoundPath({ tracks: scene, path: ["self", "self"] })).toBeNull();
	});

	test("saving strips audio buffers at every compound depth", () => {
		const sound = audio({ id: "sound", startTime: 0 });
		Reflect.set(sound, "buffer", { length: 1 });
		const child = tracksOf({ audioElements: [sound] });
		const inner: CompoundElement = {
			id: "inner", name: "Inner", type: "compound", tracks: child,
			startTime: t(0), duration: t(100), trimStart: t(0), trimEnd: t(0), params: {},
		};
		const middle = tracksOf({});
		middle.video[0].elements.push(inner);
		const outer: CompoundElement = {
			id: "outer", name: "Outer", type: "compound", tracks: middle,
			startTime: t(0), duration: t(100), trimStart: t(0), trimEnd: t(0), params: {},
		};
		const root = tracksOf({});
		root.video[0].elements.push(outer);
		const saved = stripAudioBuffersFromTracks({ tracks: root });
		const nested = getCompoundPath({ tracks: saved, path: ["outer", "inner"] });
		expect(Reflect.has(nested?.content.audio[0].elements[0] ?? {}, "buffer")).toBe(false);
		expect(Reflect.has(sound, "buffer")).toBe(true);
	});

	test("nested edits write through the root and update the compound span", () => {
		const child = tracksOf({ videoElements: [video({ id: "a", startTime: 0, duration: TPS })] });
		const compound: CompoundElement = {
			id: "nested", name: "Nested", type: "compound", tracks: child,
			startTime: t(0), duration: t(TPS), trimStart: t(0), trimEnd: t(0), params: {},
		};
		const root = tracksOf({});
		root.video[0].elements.push(compound);
		const edited: SceneTracks = {
			...child,
			video: [{ ...child.video[0], elements: [video({ id: "a", startTime: 0, duration: 2 * TPS })] }],
		};
		const next = replaceCompoundPath({ tracks: root, path: ["nested"], content: edited });
		expect(next?.video[0].elements[0].duration).toBe(t(2 * TPS));
		expect(root.video[0].elements[0].duration).toBe(t(TPS));
	});
});
