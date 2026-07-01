import { describe, expect, test } from "bun:test";
import type { MediaTime } from "@/wasm";
import type { TScene, VideoElement, VideoTrack } from "@/timeline";
import { mergeSceneTracks } from "@/timeline/scenes";
import {
	getRenderableTrackTransitions,
	registerDefaultTransitions,
	upsertTrackTransition,
} from "@/transitions";
import { addMediaTime, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

registerDefaultTransitions();

function buildVideoElement({
	id,
	startTime,
	duration = mediaTime({ ticks: 30 }),
}: {
	id: string;
	startTime: MediaTime;
	duration?: MediaTime;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: `${id}-media`,
		startTime,
		duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function getElementEndTime({ element }: { element: VideoElement }): MediaTime {
	return addMediaTime({
		a: element.startTime,
		b: element.duration,
	});
}

function buildVideoTrack({
	id,
	elements,
}: {
	id: string;
	elements: VideoElement[];
}): VideoTrack {
	const [first, second] = elements;
	return {
		id,
		name: id,
		type: "video",
		elements,
		transitions:
			first && second
				? upsertTrackTransition({
						track: {
							id,
							name: id,
							type: "video",
							elements,
							transitions: [],
							muted: false,
							hidden: false,
						},
						from: first,
						to: second,
						type: "crossfade",
					})
				: [],
		muted: false,
		hidden: false,
	};
}

function buildScene({
	id,
	mainTrack,
	overlay = [],
}: {
	id: string;
	mainTrack: VideoTrack;
	overlay?: TScene["tracks"]["overlay"];
}): TScene {
	return {
		id,
		name: id,
		isMain: false,
		tracks: {
			main: mainTrack,
			overlay,
			audio: [],
		},
		bookmarks: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

describe("track transitions", () => {
	test("only exposes transitions for adjacent contiguous clips", () => {
		const first = buildVideoElement({
			id: "first",
			startTime: ZERO_MEDIA_TIME,
		});
		const second = buildVideoElement({
			id: "second",
			startTime: getElementEndTime({ element: first }),
		});
		const gapClip = buildVideoElement({
			id: "gap",
			startTime: addMediaTime({
				a: getElementEndTime({ element: second }),
				b: mediaTime({ ticks: 5 }),
			}),
		});

		const track: VideoTrack = {
			id: "track-1",
			name: "Track 1",
			type: "video",
			elements: [first, second, gapClip],
			transitions: [
				...upsertTrackTransition({
					track: {
						id: "track-1",
						name: "Track 1",
						type: "video",
						elements: [first, second, gapClip],
						transitions: [],
						muted: false,
						hidden: false,
					},
					from: first,
					to: second,
					type: "crossfade",
				}),
				{
					id: "stale-transition",
					type: "crossfade",
					fromElementId: second.id,
					toElementId: gapClip.id,
					duration: mediaTime({ ticks: 10 }),
					enabled: true,
				},
			],
			muted: false,
			hidden: false,
		};

		const renderableTransitions = getRenderableTrackTransitions({ track });

		expect(renderableTransitions).toHaveLength(1);
		expect(renderableTransitions[0]?.from.id).toBe(first.id);
		expect(renderableTransitions[0]?.to.id).toBe(second.id);
	});

	test("remaps transition element ids when scenes are merged", () => {
		const sceneOneMain = buildVideoTrack({
			id: "main-1",
			elements: [
				buildVideoElement({ id: "scene-1-a", startTime: ZERO_MEDIA_TIME }),
				buildVideoElement({
					id: "scene-1-b",
					startTime: mediaTime({ ticks: 30 }),
				}),
			],
		});
		const sceneOneOverlay = buildVideoTrack({
			id: "overlay-1",
			elements: [
				buildVideoElement({ id: "scene-1-c", startTime: ZERO_MEDIA_TIME }),
				buildVideoElement({
					id: "scene-1-d",
					startTime: mediaTime({ ticks: 30 }),
				}),
			],
		});
		const sceneTwoMain = buildVideoTrack({
			id: "main-2",
			elements: [
				buildVideoElement({ id: "scene-2-a", startTime: ZERO_MEDIA_TIME }),
				buildVideoElement({
					id: "scene-2-b",
					startTime: mediaTime({ ticks: 30 }),
				}),
			],
		});

		const { tracks } = mergeSceneTracks({
			scenes: [
				buildScene({
					id: "scene-1",
					mainTrack: sceneOneMain,
					overlay: [sceneOneOverlay],
				}),
				buildScene({
					id: "scene-2",
					mainTrack: sceneTwoMain,
				}),
			],
		});

		expect(tracks.main.transitions).toHaveLength(2);
		expect(tracks.overlay[0]?.type).toBe("video");
		if (tracks.overlay[0]?.type !== "video") {
			throw new Error("Expected merged overlay track to stay video.");
		}
		expect(tracks.overlay[0].transitions).toHaveLength(1);

		const mergedMainIds = new Set(
			tracks.main.elements.map((element) => element.id),
		);
		for (const transition of tracks.main.transitions ?? []) {
			expect(mergedMainIds.has(transition.fromElementId)).toBe(true);
			expect(mergedMainIds.has(transition.toElementId)).toBe(true);
			expect(transition.fromElementId.startsWith("scene-")).toBe(false);
			expect(transition.toElementId.startsWith("scene-")).toBe(false);
		}

		const mergedOverlayIds = new Set(
			tracks.overlay[0].elements.map((element) => element.id),
		);
		for (const transition of tracks.overlay[0].transitions ?? []) {
			expect(mergedOverlayIds.has(transition.fromElementId)).toBe(true);
			expect(mergedOverlayIds.has(transition.toElementId)).toBe(true);
		}
	});
});
