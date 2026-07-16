import type { ClipMarker, SceneTracks } from "@/timeline/types";
import {
	addMediaTime,
	clampMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";

/**
 * Pure helpers for clip-level markers (EDIT-005).
 *
 * A {@link ClipMarker} stores an element-local time (0 = the element's own
 * `startTime`); these functions convert to/from absolute timeline time and keep
 * a clip's marker list sorted and duplicate-free. All operations are pure and
 * return new arrays — the manager wraps them in an undoable command.
 */

/** Sort a clip's markers ascending by their element-local time. New array. */
export function sortClipMarkers({
	markers,
}: {
	markers: ClipMarker[];
}): ClipMarker[] {
	return [...markers].sort((a, b) => a.time - b.time);
}

/**
 * Insert a marker into a clip's list, replacing any existing marker at the same
 * tick so re-adding at an occupied position updates rather than duplicates.
 * Returns a new, time-sorted array.
 */
export function addClipMarkerToList({
	markers,
	marker,
}: {
	markers: ClipMarker[];
	marker: ClipMarker;
}): ClipMarker[] {
	const withoutSameTime = markers.filter((m) => m.time !== marker.time);
	return sortClipMarkers({ markers: [...withoutSameTime, marker] });
}

/** Remove the marker at `time` (tick-exact) from a clip's list. New array. */
export function removeClipMarkerFromList({
	markers,
	time,
}: {
	markers: ClipMarker[];
	time: MediaTime;
}): ClipMarker[] {
	return markers.filter((m) => m.time !== time);
}

/**
 * Patch the note/color of the marker at `time` (tick-exact). `time` itself is
 * never changed here (a marker's position moves with its clip, not by edit).
 * Returns a new array; unmatched markers pass through unchanged.
 */
export function updateClipMarkerInList({
	markers,
	time,
	updates,
}: {
	markers: ClipMarker[];
	time: MediaTime;
	updates: Partial<Omit<ClipMarker, "time">>;
}): ClipMarker[] {
	return markers.map((m) => (m.time === time ? { ...m, ...updates } : m));
}

/** Absolute timeline time of a clip marker = element start + its local time. */
export function clipMarkerAbsoluteTime({
	elementStartTime,
	marker,
}: {
	elementStartTime: MediaTime;
	marker: ClipMarker;
}): MediaTime {
	return addMediaTime({ a: elementStartTime, b: marker.time });
}

/**
 * Convert an absolute timeline time into a marker's element-local time, clamped
 * to the clip's visible span `[0, duration]`. Used when dropping a marker at the
 * playhead onto a selected clip.
 */
export function localTimeForClip({
	elementStartTime,
	elementDuration,
	absoluteTime,
}: {
	elementStartTime: MediaTime;
	elementDuration: MediaTime;
	absoluteTime: MediaTime;
}): MediaTime {
	return clampMediaTime({
		time: subMediaTime({ a: absoluteTime, b: elementStartTime }),
		min: ZERO_MEDIA_TIME,
		max: elementDuration,
	});
}

/** A clip marker flattened out of the timeline for list/jump surfaces. */
export interface CollectedClipMarker {
	trackId: string;
	elementId: string;
	elementName: string;
	marker: ClipMarker;
	absoluteTime: MediaTime;
}

/**
 * Flatten every clip marker across all tracks into absolute-time-sorted rows.
 * Elements with no markers contribute nothing. Pure — reads the scene tracks and
 * returns a fresh array, so the Markers panel can list clip markers alongside
 * scene bookmarks.
 */
export function collectClipMarkers({
	tracks,
}: {
	tracks: SceneTracks;
}): CollectedClipMarker[] {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const collected: CollectedClipMarker[] = [];

	for (const track of orderedTracks) {
		for (const element of track.elements) {
			if (!element.markers) continue;
			for (const marker of element.markers) {
				collected.push({
					trackId: track.id,
					elementId: element.id,
					elementName: element.name,
					marker,
					absoluteTime: addMediaTime({
						a: element.startTime,
						b: marker.time,
					}),
				});
			}
		}
	}

	return collected.sort((a, b) => a.absoluteTime - b.absoluteTime);
}

/** Display label for a clip marker: its note if any, else the clip's name. */
export function clipMarkerLabel({
	marker,
	elementName,
}: {
	marker: ClipMarker;
	elementName: string;
}): string {
	const note = marker.note?.trim();
	return note ? note : elementName;
}
