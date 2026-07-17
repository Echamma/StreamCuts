import type { SceneTracks, TimelineTrack, VideoTrack } from "@/timeline/types";

/**
 * Semantic views + shape-arithmetic helpers over `SceneTracks`
 * (see `docs/roadmap/50-r1-uniform-tracks-spike.md`).
 *
 * Post-R1 the shape is `{ video[], text[], graphic[], effect[], audio[] }`
 * with each band ordered bottom-to-top by compositing z-order. `video[0]` is
 * the ripple track (the former `main`). These helpers stay non-trivial:
 * band access should just be `tracks.text` etc.; use these when the caller
 * needs "the ripple track", the enumeration across bands, or index math.
 */

/**
 * The bottom-most video track — the ripple track. Post-R1 this is `video[0]`;
 * callers that used this to mean "the former `main`" continue to work.
 */
export function getMainVideoTrack({
	tracks,
}: {
	tracks: SceneTracks;
}): VideoTrack {
	return tracks.video[0];
}

/**
 * Video tracks above the ripple track. `video.slice(1)`.
 */
export function getOverlayVideoTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): VideoTrack[] {
	return tracks.video.slice(1);
}

/**
 * Every timeline track in a stable enumeration order — a superset covering
 * every band. Post-R1 concretely: `[...text, ...graphic, ...effect, ...video,
 * ...audio]` with `video[0]` (the former `main`) at the index that
 * `getMainTrackRowIndex` returns, preserving the pre-R1 layout so consumers
 * that use the enumeration as a row-index space keep working.
 */
export function getOrderedTimelineTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): TimelineTrack[] {
	return [
		...tracks.text,
		...tracks.graphic,
		...tracks.effect,
		...tracks.video,
		...tracks.audio,
	];
}

/**
 * Look up a track by id across every band. Returns `undefined` when no track
 * has that id.
 */
export function findTrackById({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | undefined {
	const textHit = tracks.text.find((track) => track.id === trackId);
	if (textHit) return textHit;
	const graphicHit = tracks.graphic.find((track) => track.id === trackId);
	if (graphicHit) return graphicHit;
	const effectHit = tracks.effect.find((track) => track.id === trackId);
	if (effectHit) return effectHit;
	const videoHit = tracks.video.find((track) => track.id === trackId);
	if (videoHit) return videoHit;
	return tracks.audio.find((track) => track.id === trackId);
}

/**
 * Row index of the main video track in the ordered enumeration. Post-R1 the
 * ordered enumeration is `[text, graphic, effect, video, audio]`, so
 * `video[0]` (the ripple track) sits at `text + graphic + effect`. Callers
 * that used this as an insertion pivot before the flip continue to point at
 * the same relative row.
 */
export function getMainTrackRowIndex({
	tracks,
}: {
	tracks: SceneTracks;
}): number {
	return tracks.text.length + tracks.graphic.length + tracks.effect.length;
}

/**
 * First row index of the audio band in the ordered enumeration.
 * Post-R1: `text + graphic + effect + video`.
 */
export function getAudioBaseIndex({
	tracks,
}: {
	tracks: SceneTracks;
}): number {
	return (
		tracks.text.length +
		tracks.graphic.length +
		tracks.effect.length +
		tracks.video.length
	);
}

/**
 * Total row count across the ordered enumeration.
 */
export function getTotalTrackCount({
	tracks,
}: {
	tracks: SceneTracks;
}): number {
	return (
		tracks.text.length +
		tracks.graphic.length +
		tracks.effect.length +
		tracks.video.length +
		tracks.audio.length
	);
}
