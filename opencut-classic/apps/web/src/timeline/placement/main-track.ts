import type { SceneTracks, TimelineElement, VideoTrack } from "@/timeline";
import { getMainVideoTrack } from "@/timeline/scene-tracks-view";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export const MAIN_TRACK_NAME = "Main Track";

export function getEarliestMainTrackElement({
	mainTrack,
	excludeElementId,
}: {
	mainTrack: VideoTrack;
	excludeElementId?: string;
}): TimelineElement | null {
	const elements = mainTrack.elements.filter((element) => {
		return !excludeElementId || element.id !== excludeElementId;
	});
	if (elements.length === 0) {
		return null;
	}

	return elements.reduce((earliestElement, element) => {
		return element.startTime < earliestElement.startTime
			? element
			: earliestElement;
	});
}

export function enforceMainTrackStart({
	tracks,
	targetTrackId,
	requestedStartTime,
	excludeElementId,
}: {
	tracks: SceneTracks;
	targetTrackId: string;
	requestedStartTime: MediaTime;
	excludeElementId?: string;
}): MediaTime {
	const mainTrack = getMainVideoTrack({ tracks });
	if (mainTrack.id !== targetTrackId) {
		return requestedStartTime;
	}

	const earliestElement = getEarliestMainTrackElement({
		mainTrack,
		excludeElementId,
	});
	if (!earliestElement) {
		return ZERO_MEDIA_TIME;
	}

	if (requestedStartTime <= earliestElement.startTime) {
		return ZERO_MEDIA_TIME;
	}

	return requestedStartTime;
}
