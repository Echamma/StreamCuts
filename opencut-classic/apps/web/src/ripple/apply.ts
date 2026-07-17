import type { SceneTracks, TimelineTrack } from "@/timeline/types";
import { rippleShiftElements } from "./shift";

export interface RippleAdjustment {
	trackId: string;
	afterTime: number;
	shiftAmount: number;
}

export function applyRippleAdjustments({
	tracks,
	adjustments,
}: {
	tracks: SceneTracks;
	adjustments: RippleAdjustment[];
}): SceneTracks {
	if (adjustments.length === 0) {
		return tracks;
	}

	const adjustmentsByTrack = new Map<string, RippleAdjustment[]>();
	for (const adjustment of adjustments) {
		const trackAdjustments = adjustmentsByTrack.get(adjustment.trackId) ?? [];
		trackAdjustments.push(adjustment);
		adjustmentsByTrack.set(adjustment.trackId, trackAdjustments);
	}

	const applyToBand = <T extends TimelineTrack>(band: T[]): T[] =>
		band.map((track) =>
			applyTrackRippleAdjustments({
				track,
				adjustments: adjustmentsByTrack.get(track.id) ?? [],
			}),
		);

	return {
		video: applyToBand(tracks.video),
		text: applyToBand(tracks.text),
		graphic: applyToBand(tracks.graphic),
		effect: applyToBand(tracks.effect),
		audio: applyToBand(tracks.audio),
	};
}

function applyTrackRippleAdjustments<
	TElement extends TimelineTrack["elements"][number],
	TTrack extends TimelineTrack & { elements: TElement[] },
>({
	track,
	adjustments,
}: {
	track: TTrack;
	adjustments: RippleAdjustment[];
}): TTrack {
	if (adjustments.length === 0) {
		return track;
	}

	const sortedAdjustments = [...adjustments].sort(
		(firstAdjustment, secondAdjustment) =>
			secondAdjustment.afterTime - firstAdjustment.afterTime,
	);

	let elements: TElement[] = track.elements;
	for (const adjustment of sortedAdjustments) {
		elements = rippleShiftElements({
			elements,
			afterTime: adjustment.afterTime,
			shiftAmount: adjustment.shiftAmount,
		});
	}

	return { ...track, elements };
}
