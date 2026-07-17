import type {
	SceneTracks,
	TScene,
	TrackTransition,
	VideoTrack,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { calculateTotalDuration } from "@/timeline";
import { MAIN_TRACK_NAME } from "@/timeline/placement/main-track";
import { addMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function remapTrackTransitions({
	track,
	elementIdMap,
}: {
	track: VideoTrack;
	elementIdMap: Map<string, string>;
}): TrackTransition[] {
	return (track.transitions ?? []).flatMap((transition) => {
		const fromElementId = elementIdMap.get(transition.fromElementId);
		const toElementId = elementIdMap.get(transition.toElementId);
		if (!fromElementId || !toElementId) {
			return [];
		}

		return [
			{
				...transition,
				id: generateUUID(),
				fromElementId,
				toElementId,
			},
		];
	});
}

function cloneElementsWithOffset<
	TElement extends { id: string; startTime: MediaTime },
>({
	elements,
	offset,
	elementIdMap,
}: {
	elements: TElement[];
	offset: MediaTime;
	elementIdMap: Map<string, string>;
}): TElement[] {
	return elements.map((element) => {
		const nextId = generateUUID();
		elementIdMap.set(element.id, nextId);
		return {
			...element,
			id: nextId,
			startTime: addMediaTime({ a: element.startTime, b: offset }),
		};
	});
}

export function getMainScene({ scenes }: { scenes: TScene[] }): TScene | null {
	return scenes.find((scene) => scene.isMain) || null;
}

export function ensureMainScene({ scenes }: { scenes: TScene[] }): TScene[] {
	const hasMain = scenes.some((scene) => scene.isMain);
	if (!hasMain) {
		const mainScene = buildDefaultScene({ name: "Main scene", isMain: true });
		return [mainScene, ...scenes];
	}
	return scenes;
}

export function buildDefaultScene({
	name,
	isMain,
}: {
	name: string;
	isMain: boolean;
}): TScene {
	return {
		id: generateUUID(),
		name,
		isMain,
		tracks: {
			video: [
				{
					id: generateUUID(),
					name: MAIN_TRACK_NAME,
					type: "video",
					elements: [],
					transitions: [],
					muted: false,
					hidden: false,
				},
			],
			text: [],
			graphic: [],
			effect: [],
			audio: [],
		},
		bookmarks: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

export function canDeleteScene({ scene }: { scene: TScene }): {
	canDelete: boolean;
	reason?: string;
} {
	if (scene.isMain) {
		return { canDelete: false, reason: "Cannot delete main scene" };
	}
	return { canDelete: true };
}

export function getFallbackSceneAfterDelete({
	scenes,
	deletedSceneId,
	currentSceneId,
}: {
	scenes: TScene[];
	deletedSceneId: string;
	currentSceneId: string | null;
}): TScene | null {
	if (currentSceneId !== deletedSceneId) {
		return scenes.find((s) => s.id === currentSceneId) || null;
	}
	return getMainScene({ scenes });
}

export function findCurrentScene({
	scenes,
	currentSceneId,
}: {
	scenes: TScene[];
	currentSceneId: string;
}): TScene | null {
	return (
		scenes.find((s) => s.id === currentSceneId) ||
		getMainScene({ scenes }) ||
		scenes[0] ||
		null
	);
}

export function getProjectDurationFromScenes({
	scenes,
}: {
	scenes: TScene[];
}): MediaTime {
	const mainScene = getMainScene({ scenes }) ?? scenes[0] ?? null;
	if (!mainScene?.tracks) {
		return ZERO_MEDIA_TIME;
	}

	return calculateTotalDuration({ tracks: mainScene.tracks });
}

export function updateSceneInArray({
	scenes,
	sceneId,
	updates,
}: {
	scenes: TScene[];
	sceneId: string;
	updates: Partial<TScene>;
}): TScene[] {
	return scenes.map((scene) =>
		scene.id === sceneId ? { ...scene, ...updates } : scene,
	);
}

export function mergeSceneTracks({ scenes }: { scenes: TScene[] }): {
	tracks: SceneTracks;
	bookmarks: TScene["bookmarks"];
} {
	const merged: SceneTracks = {
		video: [
			{
				id: generateUUID(),
				name: MAIN_TRACK_NAME,
				type: "video",
				elements: [],
				transitions: [],
				muted: false,
				hidden: false,
			},
		],
		text: [],
		graphic: [],
		effect: [],
		audio: [],
	};
	const mergedBookmarks: TScene["bookmarks"] = [];
	let offset: MediaTime = ZERO_MEDIA_TIME;

	for (const scene of scenes) {
		const sceneDuration = calculateTotalDuration({ tracks: scene.tracks });
		const mainVideoTrack = scene.tracks.video[0];
		const mainElementIdMap = new Map<string, string>();
		merged.video[0].elements.push(
			...cloneElementsWithOffset({
				elements: mainVideoTrack.elements,
				offset,
				elementIdMap: mainElementIdMap,
			}),
		);
		merged.video[0].transitions!.push(
			...remapTrackTransitions({
				track: mainVideoTrack,
				elementIdMap: mainElementIdMap,
			}),
		);

		for (const videoOverlay of scene.tracks.video.slice(1)) {
			const elementIdMap = new Map<string, string>();
			merged.video.push({
				...videoOverlay,
				id: generateUUID(),
				elements: cloneElementsWithOffset({
					elements: videoOverlay.elements,
					offset,
					elementIdMap,
				}),
				transitions: remapTrackTransitions({
					track: videoOverlay,
					elementIdMap,
				}),
			});
		}

		for (const textTrack of scene.tracks.text) {
			const elementIdMap = new Map<string, string>();
			merged.text.push({
				...textTrack,
				id: generateUUID(),
				elements: cloneElementsWithOffset({
					elements: textTrack.elements,
					offset,
					elementIdMap,
				}),
			});
		}

		for (const graphicTrack of scene.tracks.graphic) {
			const elementIdMap = new Map<string, string>();
			merged.graphic.push({
				...graphicTrack,
				id: generateUUID(),
				elements: cloneElementsWithOffset({
					elements: graphicTrack.elements,
					offset,
					elementIdMap,
				}),
			});
		}

		for (const effectTrack of scene.tracks.effect) {
			const elementIdMap = new Map<string, string>();
			merged.effect.push({
				...effectTrack,
				id: generateUUID(),
				elements: cloneElementsWithOffset({
					elements: effectTrack.elements,
					offset,
					elementIdMap,
				}),
			});
		}

		for (const audioTrack of scene.tracks.audio) {
			merged.audio.push({
				...audioTrack,
				id: generateUUID(),
				elements: audioTrack.elements.map((el) => ({
					...el,
					id: generateUUID(),
					startTime: addMediaTime({ a: el.startTime, b: offset }),
				})),
			});
		}

		for (const bookmark of scene.bookmarks) {
			mergedBookmarks.push({
				...bookmark,
				time: addMediaTime({ a: bookmark.time, b: offset }),
			});
		}

		offset = addMediaTime({ a: offset, b: sceneDuration });
	}

	return { tracks: merged, bookmarks: mergedBookmarks };
}
