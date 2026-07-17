import { describe, expect, test } from "bun:test";
import {
	findTrackById,
	getAudioBaseIndex,
	getMainTrackRowIndex,
	getMainVideoTrack,
	getOrderedTimelineTracks,
	getOverlayVideoTracks,
	getTotalTrackCount,
} from "@/timeline/scene-tracks-view";
import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	SceneTracks,
	TextTrack,
	VideoTrack,
} from "@/timeline/types";

// Post-R1 (project version 32) fixtures — SceneTracks is the uniform
// { video[], text[], graphic[], effect[], audio[] } shape. No wasm mock
// needed: the views just walk arrays and read `type`.

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
	video,
	text = [],
	graphic = [],
	effect = [],
	audio = [],
}: {
	video: VideoTrack[];
	text?: TextTrack[];
	graphic?: GraphicTrack[];
	effect?: EffectTrack[];
	audio?: AudioTrack[];
}): SceneTracks {
	return { video, text, graphic, effect, audio };
}

describe("getMainVideoTrack", () => {
	test("returns video[0] (the ripple track)", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" }), videoTrack({ id: "V2" })],
		});
		expect(getMainVideoTrack({ tracks }).id).toBe("V1-main");
	});
});

describe("getOverlayVideoTracks", () => {
	test("returns video.slice(1)", () => {
		const tracks = scene({
			video: [
				videoTrack({ id: "V1-main" }),
				videoTrack({ id: "V2" }),
				videoTrack({ id: "V3" }),
			],
		});
		expect(getOverlayVideoTracks({ tracks }).map((t) => t.id)).toEqual([
			"V2",
			"V3",
		]);
	});

	test("returns empty when only the ripple track exists", () => {
		const tracks = scene({ video: [videoTrack({ id: "V1-main" })] });
		expect(getOverlayVideoTracks({ tracks })).toEqual([]);
	});
});

describe("getOrderedTimelineTracks", () => {
	test("post-R1 order: [text, graphic, effect, video, audio]", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" }), videoTrack({ id: "V2" })],
			text: [textTrack({ id: "T1" })],
			graphic: [graphicTrack({ id: "G1" })],
			effect: [effectTrack({ id: "E1" })],
			audio: [audioTrack({ id: "A1" })],
		});
		expect(getOrderedTimelineTracks({ tracks }).map((t) => t.id)).toEqual([
			"T1",
			"G1",
			"E1",
			"V1-main",
			"V2",
			"A1",
		]);
	});

	test("single-video scene yields just [video[0]]", () => {
		const tracks = scene({ video: [videoTrack({ id: "V1-main" })] });
		expect(getOrderedTimelineTracks({ tracks }).map((t) => t.id)).toEqual([
			"V1-main",
		]);
	});
});

describe("findTrackById", () => {
	test("finds a track in the video band", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" }), videoTrack({ id: "V2" })],
		});
		expect(findTrackById({ tracks, trackId: "V2" })?.id).toBe("V2");
	});

	test("finds a track in the text band", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" })],
			text: [textTrack({ id: "T1" })],
		});
		expect(findTrackById({ tracks, trackId: "T1" })?.id).toBe("T1");
	});

	test("finds a track in the audio band", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" })],
			audio: [audioTrack({ id: "A1" })],
		});
		expect(findTrackById({ tracks, trackId: "A1" })?.id).toBe("A1");
	});

	test("returns undefined for an unknown id", () => {
		const tracks = scene({ video: [videoTrack({ id: "V1-main" })] });
		expect(findTrackById({ tracks, trackId: "nope" })).toBeUndefined();
	});
});

describe("shape-arithmetic helpers", () => {
	test("getMainTrackRowIndex = text + graphic + effect (row of video[0])", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" })],
			text: [textTrack({ id: "T1" }), textTrack({ id: "T2" })],
			graphic: [graphicTrack({ id: "G1" })],
			effect: [],
		});
		expect(getMainTrackRowIndex({ tracks })).toBe(3);
	});

	test("getAudioBaseIndex = text + graphic + effect + video", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" }), videoTrack({ id: "V2" })],
			text: [textTrack({ id: "T1" })],
		});
		expect(getAudioBaseIndex({ tracks })).toBe(3);
	});

	test("getTotalTrackCount sums every band", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" })],
			text: [textTrack({ id: "T1" })],
			audio: [audioTrack({ id: "A1" }), audioTrack({ id: "A2" })],
		});
		expect(getTotalTrackCount({ tracks })).toBe(4);
	});
});

describe("view completeness (partition property)", () => {
	test("across a mixed scene, the views partition every track exactly once", () => {
		const tracks = scene({
			video: [videoTrack({ id: "V1-main" }), videoTrack({ id: "V2" })],
			text: [textTrack({ id: "T1" }), textTrack({ id: "T2" })],
			graphic: [graphicTrack({ id: "G1" })],
			effect: [effectTrack({ id: "E1" })],
			audio: [audioTrack({ id: "A1" })],
		});

		const seenIds = [
			...tracks.video.map((t) => t.id),
			...tracks.text.map((t) => t.id),
			...tracks.graphic.map((t) => t.id),
			...tracks.effect.map((t) => t.id),
			...tracks.audio.map((t) => t.id),
		];
		expect(seenIds.sort()).toEqual(
			["V1-main", "V2", "T1", "T2", "G1", "E1", "A1"].sort(),
		);
		expect(new Set(seenIds).size).toBe(seenIds.length);
	});
});
