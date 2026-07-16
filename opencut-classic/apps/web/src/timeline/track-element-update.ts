import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { findTrackById } from "@/timeline/scene-tracks-view";

/**
 * Kept for callers that use the `null` convention; delegates to `findTrackById`.
 * The write helpers below still reach for the concrete
 * `{ overlay, main, audio }` shape on purpose — they are the shape-native
 * abstraction that swaps at Phase C so consumers don't have to.
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

export function updateTrackInSceneTracks({
	tracks,
	trackId,
	update,
}: {
	tracks: SceneTracks;
	trackId: string;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SceneTracks {
	if (tracks.main.id === trackId) {
		return {
			...tracks,
			main: update(tracks.main),
		};
	}

	const overlayTrackIndex = tracks.overlay.findIndex((track) => track.id === trackId);
	if (overlayTrackIndex >= 0) {
		return {
			...tracks,
			overlay: tracks.overlay.map((track, index) =>
				index === overlayTrackIndex ? update(track) : track,
			),
		};
	}

	const audioTrackIndex = tracks.audio.findIndex((track) => track.id === trackId);
	if (audioTrackIndex >= 0) {
		return {
			...tracks,
			audio: tracks.audio.map((track, index) =>
				index === audioTrackIndex ? update(track) : track,
			),
		};
	}

	return tracks;
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
	if (tracks.main.id === trackId) {
		return {
			...tracks,
			main: updateElementInTrack({
				track: tracks.main,
				elementId,
				update,
				elementPredicate,
			}),
		};
	}

	const overlayTrackIndex = tracks.overlay.findIndex((track) => track.id === trackId);
	if (overlayTrackIndex >= 0) {
		return {
			...tracks,
			overlay: tracks.overlay.map((track, index) =>
				index === overlayTrackIndex
					? updateElementInTrack({
							track,
							elementId,
							update,
							elementPredicate,
						})
					: track,
			),
		};
	}

	const audioTrackIndex = tracks.audio.findIndex((track) => track.id === trackId);
	if (audioTrackIndex >= 0) {
		return {
			...tracks,
			audio: tracks.audio.map((track, index) =>
				index === audioTrackIndex
					? updateElementInTrack({
							track,
							elementId,
							update,
							elementPredicate,
						})
					: track,
			),
		};
	}

	return tracks;
}
