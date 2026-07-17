import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	OverlayTrack,
	SceneTracks,
	TextTrack,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { buildEmptyTrack } from "./track-factory";
import type { PlacementResult } from "./types";
import { updateTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	getAudioBaseIndex,
	getMainTrackRowIndex,
	getOrderedTimelineTracks,
} from "@/timeline/scene-tracks-view";

export function applyPlacement({
	tracks,
	placementResult,
	elements,
	newTrackInsertIndexOverride,
}: {
	tracks: SceneTracks;
	placementResult: PlacementResult;
	elements: TimelineElement[];
	newTrackInsertIndexOverride?: number;
}): { updatedTracks: SceneTracks; targetTrackId: string } | null {
	const orderedTracks = getOrderedTimelineTracks({ tracks });
	if (placementResult.kind === "existingTrack") {
		const targetTrack = orderedTracks[placementResult.trackIndex];
		if (!targetTrack) {
			return null;
		}

		const updatedTracks = updateTrackInSceneTracks({
			tracks,
			trackId: targetTrack.id,
			update: (track) => ({
				...track,
				elements: [...track.elements, ...elements],
			}),
		});

		return { updatedTracks, targetTrackId: targetTrack.id };
	}

	const newTrackId = generateUUID();
	const insertIndex =
		newTrackInsertIndexOverride ?? placementResult.insertIndex;
	const updatedTracks =
		placementResult.trackType === "audio"
			? {
					...tracks,
					audio: insertIntoAudioTracks({
						tracks,
						insertIndex,
						track: buildPlacedAudioTrack({
							id: newTrackId,
							elements,
						}),
					}),
				}
			: insertOverlayIntoBand({
					tracks,
					insertIndex,
					track: buildPlacedOverlayTrack({
						id: newTrackId,
						type: placementResult.trackType,
						elements,
					}),
				});
	return { updatedTracks, targetTrackId: newTrackId };
}

function insertOverlayIntoBand({
	tracks,
	insertIndex,
	track,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	track: OverlayTrack;
}): SceneTracks {
	// Post-R1 each overlay kind lives in its own band. The insertIndex is a
	// row in the ordered enumeration [text, graphic, effect, video, audio];
	// we translate it to a band-local index and splice.
	if (track.type === "video") {
		const bandIndex = Math.max(
			0,
			Math.min(insertIndex - getMainTrackRowIndex({ tracks }), tracks.video.length),
		);
		return {
			...tracks,
			video: spliceInsert({ band: tracks.video, index: bandIndex, track }),
		};
	}
	if (track.type === "text") {
		const bandIndex = Math.max(0, Math.min(insertIndex, tracks.text.length));
		return {
			...tracks,
			text: spliceInsert({ band: tracks.text, index: bandIndex, track }),
		};
	}
	if (track.type === "graphic") {
		const bandIndex = Math.max(0, Math.min(insertIndex, tracks.graphic.length));
		return {
			...tracks,
			graphic: spliceInsert({ band: tracks.graphic, index: bandIndex, track }),
		};
	}
	// effect
	const bandIndex = Math.max(0, Math.min(insertIndex, tracks.effect.length));
	return {
		...tracks,
		effect: spliceInsert({ band: tracks.effect, index: bandIndex, track }),
	};
}

function spliceInsert<T>({
	band,
	index,
	track,
}: {
	band: T[];
	index: number;
	track: T;
}): T[] {
	const next = [...band];
	next.splice(index, 0, track);
	return next;
}

function insertIntoAudioTracks({
	tracks,
	insertIndex,
	track,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	track: AudioTrack;
}): AudioTrack[] {
	const audioInsertIndex = Math.max(
		0,
		Math.min(insertIndex - getAudioBaseIndex({ tracks }), tracks.audio.length),
	);
	const nextTracks = [...tracks.audio];
	nextTracks.splice(audioInsertIndex, 0, track);
	return nextTracks;
}

function buildPlacedAudioTrack({
	id,
	elements,
}: {
	id: string;
	elements: TimelineElement[];
}): AudioTrack {
	return {
		...buildEmptyTrack({ id, type: "audio" }),
		elements: elements as AudioTrack["elements"],
	};
}

function buildPlacedOverlayTrack({
	id,
	type,
	elements,
}: {
	id: string;
	type: Exclude<OverlayTrack["type"], "audio">;
	elements: TimelineElement[];
}): OverlayTrack {
	switch (type) {
		case "video":
			return {
				...buildEmptyTrack({ id, type: "video" }),
				elements: elements as VideoTrack["elements"],
			};
		case "text":
			return {
				...buildEmptyTrack({ id, type: "text" }),
				elements: elements as TextTrack["elements"],
			};
		case "graphic":
			return {
				...buildEmptyTrack({ id, type: "graphic" }),
				elements: elements as GraphicTrack["elements"],
			};
		case "effect":
			return {
				...buildEmptyTrack({ id, type: "effect" }),
				elements: elements as EffectTrack["elements"],
			};
	}
}
