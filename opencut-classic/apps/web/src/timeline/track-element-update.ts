import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { findTrackById } from "@/timeline/scene-tracks-view";

/**
 * Kept for callers that use the `null` convention; delegates to `findTrackById`.
 */
export function findTrackInSceneTracks({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | null {
	return findTrackById({ tracks, trackId }) ?? null;
}

type TrackBandKey = "video" | "text" | "graphic" | "effect" | "audio";

const BAND_KEYS: readonly TrackBandKey[] = [
	"video",
	"text",
	"graphic",
	"effect",
	"audio",
];

/**
 * Locate which band a track lives in (and its position within it). Post-R1
 * every track lives in exactly one band. Returns `null` when no band matches.
 */
function locateBand({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): { band: TrackBandKey; index: number } | null {
	for (const band of BAND_KEYS) {
		const index = tracks[band].findIndex((track) => track.id === trackId);
		if (index >= 0) return { band, index };
	}
	return null;
}

export function updateTrackInSceneTracks({
	tracks,
	trackId,
	update,
}: {
	tracks: SceneTracks;
	trackId: string;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SceneTracks {
	const location = locateBand({ tracks, trackId });
	if (!location) {
		return tracks;
	}

	switch (location.band) {
		case "video":
			return {
				...tracks,
				video: tracks.video.map((track, index) =>
					index === location.index ? update(track) : track,
				),
			};
		case "text":
			return {
				...tracks,
				text: tracks.text.map((track, index) =>
					index === location.index ? update(track) : track,
				),
			};
		case "graphic":
			return {
				...tracks,
				graphic: tracks.graphic.map((track, index) =>
					index === location.index ? update(track) : track,
				),
			};
		case "effect":
			return {
				...tracks,
				effect: tracks.effect.map((track, index) =>
					index === location.index ? update(track) : track,
				),
			};
		case "audio":
			return {
				...tracks,
				audio: tracks.audio.map((track, index) =>
					index === location.index ? update(track) : track,
				),
			};
	}
}

function updateElementInTrack<TTrack extends TimelineTrack>({
	track,
	elementId,
	update,
	elementPredicate,
}: {
	track: TTrack;
	elementId: string;
	update: (element: TimelineElement) => TimelineElement;
	elementPredicate?: (element: TimelineElement) => boolean;
}): TTrack {
	const nextElements = track.elements.map((element) => {
		if (element.id !== elementId) {
			return element;
		}
		if (elementPredicate && !elementPredicate(element)) {
			return element;
		}
		return update(element);
	});

	return {
		...track,
		elements: nextElements,
	} as TTrack;
}

export function updateElementInSceneTracks({
	tracks,
	trackId,
	elementId,
	update,
	elementPredicate,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
	update: (element: TimelineElement) => TimelineElement;
	elementPredicate?: (element: TimelineElement) => boolean;
}): SceneTracks {
	return updateTrackInSceneTracks({
		tracks,
		trackId,
		update: (track) =>
			updateElementInTrack({
				track,
				elementId,
				update,
				elementPredicate,
			}),
	});
}
