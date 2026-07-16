import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	SceneTracks,
	TextTrack,
	VideoTrack,
} from "@/timeline/types";

/**
 * R1 compatibility views over `SceneTracks` (see
 * `docs/roadmap/50-r1-uniform-tracks-spike.md`).
 *
 * These functions expose the *target* shape of R1 (one uniform video list,
 * plus text/graphic/effect/audio lists) while reading the *current* shape
 * ({ overlay, main, audio }). Consumers migrate to these views one at a time
 * during Phase B; on the Phase C flip only the bodies below change, and every
 * consumer already reads the target shape's slices.
 *
 * Convention for the video list: bottom-to-top by compositing z-order.
 * `getAllVideoTracks()[0]` is the former `main` (the ripple track); higher
 * indices render on top. This matches `tracks.main` sitting below `overlay`
 * in the current renderer.
 */

/**
 * Every video track in the scene, bottom-to-top: `[main, ...overlay-videos]`.
 * When R1 lands this becomes `tracks.video` directly.
 */
export function getAllVideoTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): VideoTrack[] {
	const overlayVideo = tracks.overlay.filter(
		(track): track is VideoTrack => track.type === "video",
	);
	return [tracks.main, ...overlayVideo];
}

/**
 * The bottom-most video track — the current `main` and, post-R1, `video[0]`.
 * Kept as a distinct view for call-sites that need "the ripple track" today
 * without caring about z-order semantics.
 */
export function getMainVideoTrack({
	tracks,
}: {
	tracks: SceneTracks;
}): VideoTrack {
	return tracks.main;
}

/**
 * Video tracks above the main one — the current `overlay` filter, post-R1
 * `video.slice(1)`.
 */
export function getOverlayVideoTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): VideoTrack[] {
	return tracks.overlay.filter(
		(track): track is VideoTrack => track.type === "video",
	);
}

/** All text tracks; today they live inside `overlay`, post-R1 `tracks.text`. */
export function getTextTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): TextTrack[] {
	return tracks.overlay.filter(
		(track): track is TextTrack => track.type === "text",
	);
}

/** All graphic tracks. */
export function getGraphicTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): GraphicTrack[] {
	return tracks.overlay.filter(
		(track): track is GraphicTrack => track.type === "graphic",
	);
}

/** All effect tracks. */
export function getEffectTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): EffectTrack[] {
	return tracks.overlay.filter(
		(track): track is EffectTrack => track.type === "effect",
	);
}

/**
 * Audio tracks. Kept as a view for symmetry — the shape doesn't change under
 * R1, but a single migration point makes future audio-track refactors cheap.
 */
export function getAudioTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): AudioTrack[] {
	return tracks.audio;
}
