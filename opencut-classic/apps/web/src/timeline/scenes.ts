import type { SceneTracks, TScene } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { calculateTotalDuration } from "@/timeline";
import { MAIN_TRACK_NAME } from "@/timeline/placement/main-track";
import { addMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

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
			overlay: [],
			main: {
				id: generateUUID(),
				name: MAIN_TRACK_NAME,
				type: "video",
				elements: [],
				muted: false,
				hidden: false,
			},
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

export function mergeSceneTracks({
	scenes,
}: {
	scenes: TScene[];
}): { tracks: SceneTracks; bookmarks: TScene["bookmarks"] } {
	const merged: SceneTracks = {
		overlay: [],
		main: {
			id: generateUUID(),
			name: MAIN_TRACK_NAME,
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		},
		audio: [],
	};
	const mergedBookmarks: TScene["bookmarks"] = [];
	let offset: MediaTime = ZERO_MEDIA_TIME;

	for (const scene of scenes) {
		const sceneDuration = calculateTotalDuration({ tracks: scene.tracks });

		for (const el of scene.tracks.main.elements) {
			merged.main.elements.push({
				...el,
				id: generateUUID(),
				startTime: addMediaTime({ a: el.startTime, b: offset }),
			});
		}

		for (const overlayTrack of scene.tracks.overlay) {
			merged.overlay.push({
				...overlayTrack,
				id: generateUUID(),
				elements: overlayTrack.elements.map((el) => ({
					...el,
					id: generateUUID(),
					startTime: addMediaTime({ a: el.startTime, b: offset }),
				})),
			} as typeof overlayTrack);
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
