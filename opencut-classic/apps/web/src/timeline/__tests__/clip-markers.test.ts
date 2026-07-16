import { describe, expect, mock, test } from "bun:test";

// Clip-marker helpers use `@/wasm` MediaTime arithmetic, whose wasm-bindgen
// binary cannot instantiate under `bun test`. Stub `@/wasm` with faithful pure
// implementations (same pattern as the trim suite) — add/sub/clamp are exactly
// the semantics under test here.
mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	clampMediaTime: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => (time < min ? min : time > max ? max : time),
}));

const { mediaTime } = await import("@/wasm");
const {
	sortClipMarkers,
	addClipMarkerToList,
	removeClipMarkerFromList,
	updateClipMarkerInList,
	clipMarkerAbsoluteTime,
	localTimeForClip,
	collectClipMarkers,
	clipMarkerLabel,
} = await import("@/timeline/clip-markers");

type ClipMarker = import("@/timeline/types").ClipMarker;
type SceneTracks = import("@/timeline/types").SceneTracks;
type TextElement = import("@/timeline/types").TextElement;

/** Branded `MediaTime` from a tick count (the stub returns a bare number). */
function at({ ticks }: { ticks: number }) {
	return mediaTime({ ticks });
}

function marker({
	ticks,
	note,
	color,
}: {
	ticks: number;
	note?: string;
	color?: string;
}): ClipMarker {
	return { time: at({ ticks }), note, color };
}

/** Minimal but fully-typed text element (no casts). */
function textElement({
	id,
	name,
	startTime,
	markers,
}: {
	id: string;
	name: string;
	startTime: number;
	markers?: ClipMarker[];
}): TextElement {
	return {
		id,
		name,
		type: "text",
		startTime: at({ ticks: startTime }),
		duration: at({ ticks: 1000 }),
		trimStart: at({ ticks: 0 }),
		trimEnd: at({ ticks: 0 }),
		params: {},
		markers,
	};
}

function sceneTracksWith({
	elements,
}: {
	elements: TextElement[];
}): SceneTracks {
	return {
		overlay: [
			{ id: "overlay-1", name: "Text", type: "text", hidden: false, elements },
		],
		main: {
			id: "main-1",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [],
		},
		audio: [],
	};
}

describe("sortClipMarkers", () => {
	test("returns a new ascending-by-time array without mutating input", () => {
		const input = [
			marker({ ticks: 500 }),
			marker({ ticks: 100 }),
			marker({ ticks: 300 }),
		];
		const sorted = sortClipMarkers({ markers: input });
		expect(sorted.map((m) => m.time)).toEqual([
			at({ ticks: 100 }),
			at({ ticks: 300 }),
			at({ ticks: 500 }),
		]);
		expect(input.map((m) => m.time)).toEqual([
			at({ ticks: 500 }),
			at({ ticks: 100 }),
			at({ ticks: 300 }),
		]);
	});
});

describe("addClipMarkerToList", () => {
	test("inserts and keeps the list sorted", () => {
		const result = addClipMarkerToList({
			markers: [marker({ ticks: 100 }), marker({ ticks: 300 })],
			marker: marker({ ticks: 200 }),
		});
		expect(result.map((m) => m.time)).toEqual([
			at({ ticks: 100 }),
			at({ ticks: 200 }),
			at({ ticks: 300 }),
		]);
	});

	test("replaces an existing marker at the same tick (no duplicate)", () => {
		const result = addClipMarkerToList({
			markers: [marker({ ticks: 100, note: "old" }), marker({ ticks: 300 })],
			marker: marker({ ticks: 100, note: "new" }),
		});
		expect(result.length).toBe(2);
		expect(result.find((m) => m.time === at({ ticks: 100 }))?.note).toBe("new");
	});
});

describe("removeClipMarkerFromList", () => {
	test("removes the tick-exact marker, leaving the rest", () => {
		const result = removeClipMarkerFromList({
			markers: [marker({ ticks: 100 }), marker({ ticks: 300 })],
			time: at({ ticks: 100 }),
		});
		expect(result.map((m) => m.time)).toEqual([at({ ticks: 300 })]);
	});

	test("no-op when no marker matches", () => {
		const markers = [marker({ ticks: 100 }), marker({ ticks: 300 })];
		expect(
			removeClipMarkerFromList({ markers, time: at({ ticks: 999 }) }).length,
		).toBe(2);
	});
});

describe("updateClipMarkerInList", () => {
	test("patches note/color of the tick-exact marker, keeps time", () => {
		const result = updateClipMarkerInList({
			markers: [marker({ ticks: 100 }), marker({ ticks: 300, note: "keep" })],
			time: at({ ticks: 100 }),
			updates: { note: "edited", color: "#ff0000" },
		});
		const edited = result.find((m) => m.time === at({ ticks: 100 }));
		expect(edited?.note).toBe("edited");
		expect(edited?.color).toBe("#ff0000");
		expect(edited?.time).toBe(at({ ticks: 100 }));
		// other markers untouched
		expect(result.find((m) => m.time === at({ ticks: 300 }))?.note).toBe("keep");
	});

	test("no-op when no marker matches the time", () => {
		const markers = [marker({ ticks: 100, note: "a" })];
		const result = updateClipMarkerInList({
			markers,
			time: at({ ticks: 999 }),
			updates: { note: "b" },
		});
		expect(result.map((m) => m.note)).toEqual(["a"]);
	});
});

describe("clipMarkerAbsoluteTime", () => {
	test("absolute = element start + local marker time", () => {
		expect(
			clipMarkerAbsoluteTime({
				elementStartTime: at({ ticks: 1000 }),
				marker: marker({ ticks: 250 }),
			}),
		).toBe(at({ ticks: 1250 }));
	});
});

describe("localTimeForClip", () => {
	test("subtracts the clip start", () => {
		expect(
			localTimeForClip({
				elementStartTime: at({ ticks: 1000 }),
				elementDuration: at({ ticks: 500 }),
				absoluteTime: at({ ticks: 1200 }),
			}),
		).toBe(at({ ticks: 200 }));
	});

	test("clamps before the clip to 0", () => {
		expect(
			localTimeForClip({
				elementStartTime: at({ ticks: 1000 }),
				elementDuration: at({ ticks: 500 }),
				absoluteTime: at({ ticks: 400 }),
			}),
		).toBe(at({ ticks: 0 }));
	});

	test("clamps past the clip end to duration", () => {
		expect(
			localTimeForClip({
				elementStartTime: at({ ticks: 1000 }),
				elementDuration: at({ ticks: 500 }),
				absoluteTime: at({ ticks: 9999 }),
			}),
		).toBe(at({ ticks: 500 }));
	});
});

describe("collectClipMarkers", () => {
	test("flattens across clips and sorts by absolute time", () => {
		const tracks = sceneTracksWith({
			elements: [
				textElement({
					id: "a",
					name: "Clip A",
					startTime: 1000,
					markers: [marker({ ticks: 300 }), marker({ ticks: 100 })],
				}),
				textElement({
					id: "b",
					name: "Clip B",
					startTime: 50,
					markers: [marker({ ticks: 0 })],
				}),
				textElement({ id: "c", name: "Clip C", startTime: 5000 }),
			],
		});

		const collected = collectClipMarkers({ tracks });
		// b@50 (abs 50), a@1100, a@1300 — c has no markers
		expect(collected.map((c) => c.absoluteTime)).toEqual([
			at({ ticks: 50 }),
			at({ ticks: 1100 }),
			at({ ticks: 1300 }),
		]);
		expect(collected[0].elementId).toBe("b");
		expect(collected[0].elementName).toBe("Clip B");
		expect(collected[1].trackId).toBe("overlay-1");
	});

	test("returns an empty array when no clip has markers", () => {
		const tracks = sceneTracksWith({
			elements: [textElement({ id: "a", name: "Clip A", startTime: 0 })],
		});
		expect(collectClipMarkers({ tracks })).toEqual([]);
	});
});

describe("clipMarkerLabel", () => {
	test("uses the note when present", () => {
		expect(
			clipMarkerLabel({
				marker: marker({ ticks: 0, note: "Cut here" }),
				elementName: "Clip A",
			}),
		).toBe("Cut here");
	});

	test("falls back to the element name when the note is blank/absent", () => {
		expect(
			clipMarkerLabel({ marker: marker({ ticks: 0 }), elementName: "Clip A" }),
		).toBe("Clip A");
		expect(
			clipMarkerLabel({
				marker: marker({ ticks: 0, note: "   " }),
				elementName: "Clip A",
			}),
		).toBe("Clip A");
	});
});
