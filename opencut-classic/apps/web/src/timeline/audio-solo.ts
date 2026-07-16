import type { SceneTracks, TimelineTrack } from "@/timeline";
import { getOrderedTimelineTracks } from "@/timeline/scene-tracks-view";
import { canTrackHaveAudio } from "@/timeline/track-capabilities";

/** All audio-capable tracks (video + audio) across a scene. */
function audioCapableTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): TimelineTrack[] {
	return getOrderedTimelineTracks({ tracks }).filter(canTrackHaveAudio);
}

/** True when at least one audio-capable track is soloed. Once solo is active,
 * only soloed tracks are audible (FAIR-001 mixer solo). */
export function anyTrackSoloed({ tracks }: { tracks: SceneTracks }): boolean {
	return audioCapableTracks({ tracks }).some((track) =>
		canTrackHaveAudio(track) ? track.soloed === true : false,
	);
}

/** Single source of truth for whether a track's audio should be silenced,
 * combining explicit mute with solo state. Every audio-collection path routes
 * through this so playback and export stay consistent.
 *
 * `soloActive` is passed in (computed once via `anyTrackSoloed`) so callers can
 * avoid recomputing it inside a per-track loop. */
export function isTrackAudioSilenced({
	track,
	soloActive,
}: {
	track: TimelineTrack;
	soloActive: boolean;
}): boolean {
	if (!canTrackHaveAudio(track)) return false;
	if (track.muted) return true;
	return soloActive && track.soloed !== true;
}
