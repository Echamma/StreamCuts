import { getSourceTimeAtClipTime } from "@/retime/resolve";
import { TICKS_PER_SECOND } from "@/wasm";
import { anyTrackSoloed, isTrackAudioSilenced } from "./audio-solo";
import type { AudioElement, SceneTracks, VideoElement } from "./types";

/** A source clip cropped to the visible portion of its compound ancestry. */
export interface FlattenedAudioElement {
	element: AudioElement | VideoElement;
	startTime: number;
	duration: number;
	trimStart: number;
	/** Position of the visible start in the original clip (for fades/keyframes). */
	localOffset: number;
	trackMuted: boolean;
}

/** Resolve nested clip time into scene time without changing source elements. */
export function flattenAudioElements({
	tracks,
}: {
	tracks: SceneTracks;
}): FlattenedAudioElement[] {
	const flattened: FlattenedAudioElement[] = [];
	const walk = ({
		content,
		offset,
		windowStart,
		windowEnd,
		inheritedMute,
		activeIds,
	}: {
		content: SceneTracks;
		offset: number;
		windowStart: number;
		windowEnd: number;
		inheritedMute: boolean;
		activeIds: ReadonlySet<string>;
	}) => {
		const soloActive = anyTrackSoloed({ tracks: content });
		for (const track of [...content.video, ...content.audio]) {
			const trackMuted =
				inheritedMute || isTrackAudioSilenced({ track, soloActive });
			for (const element of track.elements) {
				if (element.type === "compound") {
					if (activeIds.has(element.id) || element.duration <= 0) continue;
					const start = offset + element.startTime;
					const visibleStart = Math.max(windowStart, start);
					const visibleEnd = Math.min(windowEnd, start + element.duration);
					if (visibleEnd <= visibleStart) continue;
					const ancestry = new Set(activeIds);
					ancestry.add(element.id);
					walk({
						content: element.tracks,
						offset: start - element.trimStart,
						windowStart: visibleStart,
						windowEnd: visibleEnd,
						inheritedMute: trackMuted,
						activeIds: ancestry,
					});
					continue;
				}
				if (element.type !== "video" && element.type !== "audio") continue;
				const start = offset + element.startTime;
				const visibleStart = Math.max(windowStart, start);
				const visibleEnd = Math.min(windowEnd, start + element.duration);
				if (visibleEnd <= visibleStart) continue;
				const localOffset = visibleStart - start;
				flattened.push({
					element,
					startTime: visibleStart,
					duration: visibleEnd - visibleStart,
					trimStart:
						element.trimStart +
						Math.round(
							getSourceTimeAtClipTime({
								clipTime: localOffset / TICKS_PER_SECOND,
								retime: element.retime,
							}) * TICKS_PER_SECOND,
						),
					localOffset,
					trackMuted,
				});
			}
		}
	};
	walk({
		content: tracks,
		offset: 0,
		windowStart: 0,
		windowEnd: Number.POSITIVE_INFINITY,
		inheritedMute: false,
		activeIds: new Set(),
	});
	return flattened;
}
