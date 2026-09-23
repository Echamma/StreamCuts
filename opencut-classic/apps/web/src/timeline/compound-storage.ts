import type { SceneTracks } from "./types";

/** Browser AudioBuffers must never enter saved projects or snapshots. */
export function stripAudioBuffersFromTracks({
	tracks,
	activeIds = new Set<string>(),
}: {
	tracks: SceneTracks;
	activeIds?: ReadonlySet<string>;
}): SceneTracks {
	return {
		...tracks,
		video: tracks.video.map((track) => ({
			...track,
			elements: track.elements.map((element) => {
				if (element.type !== "compound") return element;
				if (activeIds.has(element.id)) {
					throw new Error(`Cyclic compound clip: ${element.id}`);
				}
				const ancestry = new Set(activeIds);
				ancestry.add(element.id);
				return {
					...element,
					tracks: stripAudioBuffersFromTracks({
						tracks: element.tracks,
						activeIds: ancestry,
					}),
				};
			}),
		})),
		audio: tracks.audio.map((track) => ({
			...track,
			elements: track.elements.map((element) => {
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}),
		})),
	};
}
