import { describe, expect, test } from "bun:test";
import {
	getAllVideoTracks,
	getAudioTracks,
	getEffectTracks,
	getGraphicTracks,
	getMainVideoTrack,
	getOrderedTimelineTracks,
	getOverlayVideoTracks,
	getTextTracks,
} from "@/timeline/scene-tracks-view";
import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	SceneTracks,
	TextTrack,
	VideoTrack,
} from "@/timeline/types";

// Small shape-only fixtures — no MediaTime arithmetic here, so no wasm mock
// is needed (the views just walk arrays and read `type`).

function videoTrack({ id }: { id: string }): VideoTrack {
	return {
		id,
		name: id,
		type: "video",
		elements: [],
		transitions: [],
		muted: false,
		hidden: false,
	};
}

function textTrack({ id }: { id: string }): TextTrack {
	return { id, name: id, type: "text", elements: [], hidden: false };
}

function graphicTrack({ id }: { id: string }): GraphicTrack {
	return { id, name: id, type: "graphic", elements: [], hidden: false };
}

function effectTrack({ id }: { id: string }): EffectTrack {
	return { id, name: id, type: "effect", elements: [], hidden: false };
}

function audioTrack({ id }: { id: string }): AudioTrack {
	return { id, name: id, type: "audio", elements: [], muted: false };
}

function scene({
	main,
	overlay = [],
	audio = [],
}: {
	main: VideoTrack;
	overlay?: SceneTracks["overlay"];
	audio?: AudioTrack[];
}): SceneTracks {
	return { main, overlay, audio };
}

describe("getAllVideoTracks", () => {
	test("returns [main, ...overlay-videos] in that order", () => {
		const main = videoTrack({ id: "V1-main" });
		const v2 = videoTrack({ id: "V2" });
		const v3 = videoTrack({ id: "V3" });
		const tracks = scene({
			main,
			overlay: [textTrack({ id: "T1" }), v2, graphicTrack({ id: "G1" }), v3],
		});
		expect(getAllVideoTracks({ tracks }).map((t) => t.id)).toEqual([
			"V1-main",
			"V2",
			"V3",
		]);
	});

	test("returns just [main] when no overlay videos", () => {
		const main = videoTrack({ id: "V1-main" });
		const tracks = scene({
			main,
			overlay: [textTrack({ id: "T1" }), graphicTrack({ id: "G1" })],
		});
		expect(getAllVideoTracks({ tracks }).map((t) => t.id)).toEqual(["V1-main"]);
	});
});

describe("getMainVideoTrack", () => {
	test("returns the main track (bottom-most under R1)", () => {
		const main = videoTrack({ id: "V1-main" });
		const tracks = scene({ main, overlay: [videoTrack({ id: "V2" })] });
		expect(getMainVideoTrack({ tracks }).id).toBe("V1-main");
	});
});

describe("getOverlayVideoTracks", () => {
	test("filters overlay to video-typed tracks only, preserving order", () => {
		const v2 = videoTrack({ id: "V2" });
		const v3 = videoTrack({ id: "V3" });
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			overlay: [textTrack({ id: "T1" }), v2, graphicTrack({ id: "G1" }), v3],
		});
		expect(getOverlayVideoTracks({ tracks }).map((t) => t.id)).toEqual([
			"V2",
			"V3",
		]);
	});

	test("returns empty when overlay has no video tracks", () => {
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			overlay: [textTrack({ id: "T1" })],
		});
		expect(getOverlayVideoTracks({ tracks })).toEqual([]);
	});
});

describe("getTextTracks", () => {
	test("returns text tracks in overlay order", () => {
		const t1 = textTrack({ id: "T1" });
		const t2 = textTrack({ id: "T2" });
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			overlay: [t1, videoTrack({ id: "V2" }), t2],
		});
		expect(getTextTracks({ tracks }).map((t) => t.id)).toEqual(["T1", "T2"]);
	});
});

describe("getGraphicTracks", () => {
	test("returns graphic tracks in overlay order", () => {
		const g1 = graphicTrack({ id: "G1" });
		const g2 = graphicTrack({ id: "G2" });
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			overlay: [g1, textTrack({ id: "T1" }), g2],
		});
		expect(getGraphicTracks({ tracks }).map((t) => t.id)).toEqual(["G1", "G2"]);
	});
});

describe("getEffectTracks", () => {
	test("returns effect tracks in overlay order", () => {
		const e1 = effectTrack({ id: "E1" });
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			overlay: [textTrack({ id: "T1" }), e1],
		});
		expect(getEffectTracks({ tracks }).map((t) => t.id)).toEqual(["E1"]);
	});
});

describe("getAudioTracks", () => {
	test("returns tracks.audio as-is (shape unchanged under R1)", () => {
		const a1 = audioTrack({ id: "A1" });
		const a2 = audioTrack({ id: "A2" });
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			audio: [a1, a2],
		});
		expect(getAudioTracks({ tracks }).map((t) => t.id)).toEqual(["A1", "A2"]);
	});

	test("empty audio list is preserved", () => {
		const tracks = scene({ main: videoTrack({ id: "V1-main" }) });
		expect(getAudioTracks({ tracks })).toEqual([]);
	});
});

describe("getOrderedTimelineTracks", () => {
	test("today's order: [...overlay, main, ...audio]", () => {
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			overlay: [textTrack({ id: "T1" }), videoTrack({ id: "V2" })],
			audio: [audioTrack({ id: "A1" }), audioTrack({ id: "A2" })],
		});
		expect(getOrderedTimelineTracks({ tracks }).map((t) => t.id)).toEqual([
			"T1",
			"V2",
			"V1-main",
			"A1",
			"A2",
		]);
	});

	test("empty overlay + empty audio still yields just [main]", () => {
		const tracks = scene({ main: videoTrack({ id: "V1-main" }) });
		expect(getOrderedTimelineTracks({ tracks }).map((t) => t.id)).toEqual([
			"V1-main",
		]);
	});
});

describe("view completeness (partition property)", () => {
	test("across a mixed scene, the views partition every track exactly once", () => {
		const tracks = scene({
			main: videoTrack({ id: "V1-main" }),
			overlay: [
				textTrack({ id: "T1" }),
				videoTrack({ id: "V2" }),
				graphicTrack({ id: "G1" }),
				effectTrack({ id: "E1" }),
				textTrack({ id: "T2" }),
			],
			audio: [audioTrack({ id: "A1" })],
		});

		const seenIds = [
			...getAllVideoTracks({ tracks }).map((t) => t.id),
			...getTextTracks({ tracks }).map((t) => t.id),
			...getGraphicTracks({ tracks }).map((t) => t.id),
			...getEffectTracks({ tracks }).map((t) => t.id),
			...getAudioTracks({ tracks }).map((t) => t.id),
		];
		expect(seenIds.sort()).toEqual(
			["V1-main", "V2", "T1", "T2", "G1", "E1", "A1"].sort(),
		);
		// every track surfaces in exactly one view (no duplication)
		expect(new Set(seenIds).size).toBe(seenIds.length);
	});
});
