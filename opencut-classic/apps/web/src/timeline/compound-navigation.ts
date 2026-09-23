import { measureCompoundDuration } from "./compound-clips";
import type { CompoundElement, SceneTracks } from "./types";
import { mediaTime } from "@/wasm";

/** Find a compound in the current timeline scope. */
export function findCompound({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): CompoundElement | null {
	for (const track of tracks.video) {
		const element = track.elements.find((item) => item.id === elementId);
		if (element?.type === "compound") return element;
	}
	return null;
}

export function getCompoundPath({
	tracks,
	path,
}: {
	tracks: SceneTracks;
	path: readonly string[];
}): { content: SceneTracks; compounds: CompoundElement[] } | null {
	let content = tracks;
	const compounds: CompoundElement[] = [];
	const seen = new Set<string>();
	for (const id of path) {
		if (seen.has(id)) return null;
		const compound = findCompound({ tracks: content, elementId: id });
		if (!compound) return null;
		seen.add(id);
		compounds.push(compound);
		content = compound.tracks.video.length
			? compound.tracks
			: {
					...compound.tracks,
					video: [
						{
							id: `${compound.id}:main-video`,
							name: "Video",
							type: "video",
							elements: [],
							muted: false,
							hidden: false,
						},
					],
				};
	}
	return { content, compounds };
}

/** Write an edited nested timeline back to the root project scene. */
export function replaceCompoundPath({
	tracks,
	path,
	content,
}: {
	tracks: SceneTracks;
	path: readonly string[];
	content: SceneTracks;
}): SceneTracks | null {
	if (path.length === 0) return content;
	const [id, ...rest] = path;
	let found = false;
	const video = tracks.video.map((track) => ({
		...track,
		elements: track.elements.map((element) => {
			if (element.id !== id || element.type !== "compound") return element;
			const nextContent = replaceCompoundPath({
				tracks: element.tracks,
				path: rest,
				content,
			});
			if (!nextContent) return element;
			found = true;
			const sourceDuration = measureCompoundDuration({
				content: { tracks: nextContent, duration: element.duration },
			});
			return {
				...element,
				tracks: nextContent,
				sourceDuration,
				duration: mediaTime({
					ticks: Math.max(
						0,
						sourceDuration - element.trimStart - element.trimEnd,
					),
				}),
			};
		}),
	}));
	return found ? { ...tracks, video } : null;
}
