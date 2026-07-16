import { describe, expect, test } from "bun:test";
import {
	rollbackProjectV32ToV31,
	transformProjectV31ToV32,
} from "../transformers/v31-to-v32";
import { asRecord, asRecordArray } from "./helpers";

/**
 * R1 uniform-tracks migration tests (see
 * docs/roadmap/50-r1-uniform-tracks-spike.md).
 *
 * The forward transformer flips SceneTracks from
 *   { overlay: OverlayTrack[]; main: VideoTrack; audio: AudioTrack[] }
 * to
 *   { video: VideoTrack[]; text: TextTrack[]; graphic: GraphicTrack[];
 *     effect: EffectTrack[]; audio: AudioTrack[] }
 * with `video[0]` = the former `main`, followed by every overlay VideoTrack.
 *
 * The inverse rebuilds v31 in a canonical order (overlay-videos, then text,
 * then graphic, then effect). The roundtrip test asserts v31 → v32 → v31 is
 * lossless for that canonical layout; production migrations only need to
 * reverse the split, not the exact original overlay interleaving.
 */

function videoTrack(id: string): Record<string, unknown> {
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

function textTrack(id: string): Record<string, unknown> {
	return { id, name: id, type: "text", elements: [], hidden: false };
}

function graphicTrack(id: string): Record<string, unknown> {
	return { id, name: id, type: "graphic", elements: [], hidden: false };
}

function effectTrack(id: string): Record<string, unknown> {
	return { id, name: id, type: "effect", elements: [], hidden: false };
}

function audioTrack(id: string): Record<string, unknown> {
	return { id, name: id, type: "audio", elements: [], muted: false };
}

function v31Project({
	main,
	overlay = [],
	audio = [],
}: {
	main: Record<string, unknown>;
	overlay?: Record<string, unknown>[];
	audio?: Record<string, unknown>[];
}): Record<string, unknown> {
	return {
		id: "project-r1",
		version: 31,
		metadata: {
			id: "project-r1",
			name: "R1 test",
			createdAt: "2026-07-16T00:00:00.000Z",
			updatedAt: "2026-07-16T00:00:00.000Z",
		},
		settings: {
			fps: 30,
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		currentSceneId: "scene-main",
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: { overlay, main, audio },
				bookmarks: [],
				createdAt: "2026-07-16T00:00:00.000Z",
				updatedAt: "2026-07-16T00:00:00.000Z",
			},
		],
	};
}

// ---------------------------------------------------------------------------
// forward
// ---------------------------------------------------------------------------

describe("transformProjectV31ToV32 — forward", () => {
	test("splits overlay by kind and prepends main to video[]", () => {
		const project = v31Project({
			main: videoTrack("V1-main"),
			overlay: [
				textTrack("T1"),
				videoTrack("V2"),
				graphicTrack("G1"),
				effectTrack("E1"),
				videoTrack("V3"),
			],
			audio: [audioTrack("A1"), audioTrack("A2")],
		});

		const result = transformProjectV31ToV32({ project });
		expect(result.skipped).toBe(false);
		const nextTracks = asRecord(asRecord(asRecordArray(asRecord(result.project).scenes)[0]).tracks);

		expect(asRecordArray(nextTracks.video).map((t) => t.id)).toEqual([
			"V1-main",
			"V2",
			"V3",
		]);
		expect(asRecordArray(nextTracks.text).map((t) => t.id)).toEqual(["T1"]);
		expect(asRecordArray(nextTracks.graphic).map((t) => t.id)).toEqual(["G1"]);
		expect(asRecordArray(nextTracks.effect).map((t) => t.id)).toEqual(["E1"]);
		expect(asRecordArray(nextTracks.audio).map((t) => t.id)).toEqual(["A1", "A2"]);
		// old fields are gone
		expect("main" in nextTracks).toBe(false);
		expect("overlay" in nextTracks).toBe(false);
	});

	test("empty overlay produces empty text/graphic/effect and video = [main]", () => {
		const project = v31Project({ main: videoTrack("V1-main") });
		const result = transformProjectV31ToV32({ project });
		const nextTracks = asRecord(asRecord(asRecordArray(asRecord(result.project).scenes)[0]).tracks);
		expect(asRecordArray(nextTracks.video).map((t) => t.id)).toEqual(["V1-main"]);
		expect(nextTracks.text).toEqual([]);
		expect(nextTracks.graphic).toEqual([]);
		expect(nextTracks.effect).toEqual([]);
	});

	test("bumps version to 32", () => {
		const project = v31Project({ main: videoTrack("V1-main") });
		const result = transformProjectV31ToV32({ project });
		expect(asRecord(result.project).version).toBe(32);
	});

	test("preserves relative order within each kind", () => {
		const project = v31Project({
			main: videoTrack("V1-main"),
			overlay: [
				textTrack("T1"),
				textTrack("T2"),
				videoTrack("V2"),
				textTrack("T3"),
				videoTrack("V3"),
			],
		});
		const result = transformProjectV31ToV32({ project });
		const nextTracks = asRecord(asRecord(asRecordArray(asRecord(result.project).scenes)[0]).tracks);
		expect(asRecordArray(nextTracks.text).map((t) => t.id)).toEqual([
			"T1",
			"T2",
			"T3",
		]);
		expect(asRecordArray(nextTracks.video).map((t) => t.id)).toEqual([
			"V1-main",
			"V2",
			"V3",
		]);
	});

	test("catches unknown overlay track kinds into effect (no data loss)", () => {
		const project = v31Project({
			main: videoTrack("V1-main"),
			overlay: [{ id: "X1", name: "X1", type: "future-kind", elements: [] }],
		});
		const result = transformProjectV31ToV32({ project });
		const nextTracks = asRecord(asRecord(asRecordArray(asRecord(result.project).scenes)[0]).tracks);
		expect(asRecordArray(nextTracks.effect).map((t) => t.id)).toEqual(["X1"]);
	});

	test("skips when the project is missing an id", () => {
		const result = transformProjectV31ToV32({
			project: { version: 31, scenes: [] },
		});
		expect(result.skipped).toBe(true);
	});

	test("skips when already v32", () => {
		const project = v31Project({ main: videoTrack("V1-main") });
		project.version = 32;
		const result = transformProjectV31ToV32({ project });
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("already v32");
	});

	test("skips when version is not 31", () => {
		const project = v31Project({ main: videoTrack("V1-main") });
		project.version = 30;
		const result = transformProjectV31ToV32({ project });
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("not v31");
	});

	test("handles multiple scenes independently", () => {
		const project = v31Project({ main: videoTrack("V1-main") });
		const scenes = asRecordArray(project.scenes);
		scenes.push({
			id: "scene-alt",
			name: "Alt scene",
			isMain: false,
			tracks: { overlay: [textTrack("T-alt")], main: videoTrack("V-alt"), audio: [] },
			bookmarks: [],
			createdAt: "2026-07-16T00:00:00.000Z",
			updatedAt: "2026-07-16T00:00:00.000Z",
		});
		project.scenes = scenes;

		const result = transformProjectV31ToV32({ project });
		const outScenes = asRecordArray(asRecord(result.project).scenes);
		expect(outScenes).toHaveLength(2);
		const altTracks = asRecord(outScenes[1].tracks);
		expect(asRecordArray(altTracks.video).map((t) => t.id)).toEqual(["V-alt"]);
		expect(asRecordArray(altTracks.text).map((t) => t.id)).toEqual(["T-alt"]);
	});
});

// ---------------------------------------------------------------------------
// inverse
// ---------------------------------------------------------------------------

describe("rollbackProjectV32ToV31 — inverse", () => {
	test("rebuilds main from video[0] and overlay from the rest", () => {
		const v32 = {
			id: "project-r1",
			version: 32,
			metadata: {
				id: "project-r1",
				name: "R1 test",
				createdAt: "2026-07-16T00:00:00.000Z",
				updatedAt: "2026-07-16T00:00:00.000Z",
			},
			scenes: [
				{
					id: "scene-main",
					name: "Main scene",
					isMain: true,
					tracks: {
						video: [videoTrack("V1-main"), videoTrack("V2"), videoTrack("V3")],
						text: [textTrack("T1")],
						graphic: [graphicTrack("G1")],
						effect: [effectTrack("E1")],
						audio: [audioTrack("A1")],
					},
					bookmarks: [],
					createdAt: "2026-07-16T00:00:00.000Z",
					updatedAt: "2026-07-16T00:00:00.000Z",
				},
			],
		};

		const result = rollbackProjectV32ToV31({ project: v32 });
		expect(result.skipped).toBe(false);
		const outTracks = asRecord(asRecord(asRecordArray(asRecord(result.project).scenes)[0]).tracks);
		expect(asRecord(outTracks.main).id).toBe("V1-main");
		expect(asRecordArray(outTracks.overlay).map((t) => t.id)).toEqual([
			"V2",
			"V3",
			"T1",
			"G1",
			"E1",
		]);
		expect(asRecordArray(outTracks.audio).map((t) => t.id)).toEqual(["A1"]);
	});

	test("bumps version to 31", () => {
		const v32 = {
			id: "p",
			version: 32,
			scenes: [
				{
					id: "s",
					isMain: true,
					tracks: {
						video: [videoTrack("V1")],
						text: [],
						graphic: [],
						effect: [],
						audio: [],
					},
				},
			],
		};
		const result = rollbackProjectV32ToV31({ project: v32 });
		expect(asRecord(result.project).version).toBe(31);
	});

	test("skips when already v31 or older", () => {
		const project = { id: "p", version: 31, scenes: [] };
		const result = rollbackProjectV32ToV31({ project });
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("already v31 or older");
	});

	test("skips when the project is missing an id", () => {
		const result = rollbackProjectV32ToV31({ project: { version: 32 } });
		expect(result.skipped).toBe(true);
	});

	test("omits main when there is no video (does not synthesise data)", () => {
		const v32 = {
			id: "p",
			version: 32,
			scenes: [
				{
					id: "s",
					isMain: true,
					tracks: {
						video: [],
						text: [textTrack("T1")],
						graphic: [],
						effect: [],
						audio: [],
					},
				},
			],
		};
		const result = rollbackProjectV32ToV31({ project: v32 });
		const outTracks = asRecord(asRecord(asRecordArray(asRecord(result.project).scenes)[0]).tracks);
		expect("main" in outTracks).toBe(false);
		expect(asRecordArray(outTracks.overlay).map((t) => t.id)).toEqual(["T1"]);
	});
});

// ---------------------------------------------------------------------------
// roundtrip
// ---------------------------------------------------------------------------

describe("v31 → v32 → v31 roundtrip (canonical layout)", () => {
	test("returns to a v31-shaped project with the same tracks by id + kind", () => {
		const original = v31Project({
			main: videoTrack("V1-main"),
			overlay: [
				// canonical order: overlay-videos, then text, then graphic, then effect
				videoTrack("V2"),
				videoTrack("V3"),
				textTrack("T1"),
				textTrack("T2"),
				graphicTrack("G1"),
				effectTrack("E1"),
			],
			audio: [audioTrack("A1"), audioTrack("A2")],
		});

		const forward = transformProjectV31ToV32({ project: original });
		const back = rollbackProjectV32ToV31({ project: asRecord(forward.project) });

		expect(asRecord(back.project).version).toBe(31);

		const outTracks = asRecord(asRecord(asRecordArray(asRecord(back.project).scenes)[0]).tracks);
		const origTracks = asRecord(asRecord(asRecordArray(asRecord(original).scenes)[0]).tracks);

		expect(asRecord(outTracks.main).id).toBe(asRecord(origTracks.main).id);
		expect(asRecordArray(outTracks.overlay).map((t) => t.id)).toEqual(
			asRecordArray(origTracks.overlay).map((t) => t.id),
		);
		expect(asRecordArray(outTracks.audio).map((t) => t.id)).toEqual(
			asRecordArray(origTracks.audio).map((t) => t.id),
		);
	});
});
