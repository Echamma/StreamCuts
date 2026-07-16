import type { SceneTracks, TimelineTrack } from "@/timeline";
import {
	getAudioBaseIndex,
	getMainTrackRowIndex,
	getMainVideoTrack,
	getOrderedTimelineTracks,
} from "@/timeline/scene-tracks-view";
import type { GroupTrackSection } from "./types";

export interface TrackPlacement {
	trackId: string;
	trackType: TimelineTrack["type"];
	section: GroupTrackSection;
	sectionIndex: number;
	displayIndex: number;
}

export function getDisplayTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): TimelineTrack[] {
	return getOrderedTimelineTracks({ tracks });
}

export function getTrackPlacementById({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TrackPlacement | null {
	const mainTrack = getMainVideoTrack({ tracks });
	if (mainTrack.id === trackId) {
		return {
			trackId,
			trackType: mainTrack.type,
			section: "main",
			sectionIndex: -1,
			displayIndex: getMainTrackRowIndex({ tracks }),
		};
	}

	const overlayTrackIndex = tracks.overlay.findIndex(
		(track) => track.id === trackId,
	);
	if (overlayTrackIndex >= 0) {
		return {
			trackId,
			trackType: tracks.overlay[overlayTrackIndex].type,
			section: "overlay",
			sectionIndex: overlayTrackIndex,
			displayIndex: overlayTrackIndex,
		};
	}

	const audioTrackIndex = tracks.audio.findIndex(
		(track) => track.id === trackId,
	);
	if (audioTrackIndex >= 0) {
		return {
			trackId,
			trackType: tracks.audio[audioTrackIndex].type,
			section: "audio",
			sectionIndex: audioTrackIndex,
			displayIndex: getAudioBaseIndex({ tracks }) + audioTrackIndex,
		};
	}

	return null;
}

export function getTrackPlacementByDisplayIndex({
	tracks,
	displayIndex,
}: {
	tracks: SceneTracks;
	displayIndex: number;
}): TrackPlacement | null {
	const displayTracks = getDisplayTracks({ tracks });
	const track = displayTracks[displayIndex];
	if (!track) {
		return null;
	}

	return getTrackPlacementById({
		tracks,
		trackId: track.id,
	});
}
