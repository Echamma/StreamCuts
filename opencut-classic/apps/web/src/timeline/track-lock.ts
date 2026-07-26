import type { SceneTracks, TimelineTrack } from "@/timeline";

/**
 * Track locking (EDIT-024). A locked track protects its clips from direct
 * manipulation — move, trim, delete. `locked` is optional/additive, so absence
 * means unlocked and existing projects are unaffected.
 *
 * Pure helpers (type-only imports) so they unit-test without a wasm mock.
 */
export function isTrackLocked({
	track,
}: {
	track: { locked?: boolean };
}): boolean {
	return track.locked === true;
}

function findTrackById({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | null {
	const bands: TimelineTrack[][] = [
		tracks.video,
		tracks.text,
		tracks.graphic,
		tracks.effect,
		tracks.audio,
	];
	for (const band of bands) {
		const found = band.find((track) => track.id === trackId);
		if (found) return found;
	}
	return null;
}

/** Whether the track with this id is locked (false if the track is missing). */
export function isTrackLockedById({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): boolean {
	const track = findTrackById({ tracks, trackId });
	return track ? isTrackLocked({ track }) : false;
}

/** Keep only element refs whose track is unlocked — used to gate bulk edits. */
export function filterUnlockedRefs<T extends { trackId: string }>({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: readonly T[];
}): T[] {
	return refs.filter((ref) => !isTrackLockedById({ tracks, trackId: ref.trackId }));
}
