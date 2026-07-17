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

	// Ordered enumeration: [text, graphic, effect, video, audio]. Video[0]
	// was handled above (it's `main`); any other video is an overlay.
	const textIndex = tracks.text.findIndex((track) => track.id === trackId);
	if (textIndex >= 0) {
		return {
			trackId,
			trackType: "text",
			section: "overlay",
			sectionIndex: textIndex,
			displayIndex: textIndex,
		};
	}

	const graphicIndex = tracks.graphic.findIndex((track) => track.id === trackId);
	if (graphicIndex >= 0) {
		return {
			trackId,
			trackType: "graphic",
			section: "overlay",
			sectionIndex: tracks.text.length + graphicIndex,
			displayIndex: tracks.text.length + graphicIndex,
		};
	}

	const effectIndex = tracks.effect.findIndex((track) => track.id === trackId);
	if (effectIndex >= 0) {
		const displayIndex =
			tracks.text.length + tracks.graphic.length + effectIndex;
		return {
			trackId,
			trackType: "effect",
			section: "overlay",
			sectionIndex: displayIndex,
			displayIndex,
		};
	}

	// video[1+] are overlays sitting above main (in band terms) but they
	// display below main in the ordered enumeration.
	const videoOverlayIndex = tracks.video.slice(1).findIndex(
		(track) => track.id === trackId,
	);
	if (videoOverlayIndex >= 0) {
		const displayIndex = getMainTrackRowIndex({ tracks }) + 1 + videoOverlayIndex;
		return {
			trackId,
			trackType: "video",
			section: "overlay",
			sectionIndex: videoOverlayIndex,
			displayIndex,
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
