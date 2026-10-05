import type { SceneTracks, TimelineTrack } from "./types";

/** Remove every reference to a media asset, including clips inside compounds. */
export function removeMediaReferences({
	tracks,
	mediaId,
	activeIds = new Set<string>(),
}: {
	tracks: SceneTracks;
	mediaId: string;
	activeIds?: ReadonlySet<string>;
}): SceneTracks {
	const pruneTrack = <T extends TimelineTrack>(track: T): T => {
		const elements = track.elements
			.filter(
				(element) => !("mediaId" in element && element.mediaId === mediaId),
			)
			.map((element) => {
				if (element.type !== "compound") return element;
				if (activeIds.has(element.id)) return element;
				const ancestry = new Set(activeIds);
				ancestry.add(element.id);
				return {
					...element,
					tracks: removeMediaReferences({
						tracks: element.tracks,
						mediaId,
						activeIds: ancestry,
					}),
				};
			});
		const remainingIds = new Set(elements.map((element) => element.id));
		return {
			...track,
			elements,
			...(track.type === "video" && {
				transitions: track.transitions?.filter(
					(transition) =>
						remainingIds.has(transition.fromElementId) &&
						remainingIds.has(transition.toElementId),
				),
			}),
		} as T;
	};
	return {
		video: tracks.video.map(pruneTrack),
		text: tracks.text.map(pruneTrack),
		graphic: tracks.graphic.map(pruneTrack),
		effect: tracks.effect.map(pruneTrack),
		audio: tracks.audio.map(pruneTrack),
	};
}
