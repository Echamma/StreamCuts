import type { FrameRate } from "opencut-wasm";
import {
	addMediaTime,
	clampMediaTime,
	type MediaTime,
	mediaTime,
	roundFrameTicks,
	subMediaTime,
} from "@/wasm";
import { clipDeltaToSourceDelta, negateMediaTime } from "./shared";
import type { SlipResult, TrimClip } from "./types";

/**
 * Slip: shift which span of the source a clip shows, without moving the clip on
 * the timeline. `startTime` and `duration` stay fixed; `trimStart` and
 * `trimEnd` move together by the same source-space amount, so the stored
 * invariant `trimStart + duration * rate + trimEnd === sourceDuration` is
 * preserved exactly.
 *
 * `requestedDelta` is a clip-space (timeline-tick) delta — the distance a slip
 * gesture travels. It is frame-snapped, converted to source space, then clamped
 * to the available handles: `trimStart` of head room and `trimEnd` of tail
 * room. A positive delta reveals later source frames.
 *
 * Returns `null` when the slip resolves to no movement (no handle on the
 * requested side, or a sub-frame request).
 */
export function computeSlip({
	clip,
	requestedDelta,
	fps,
}: {
	clip: TrimClip;
	requestedDelta: MediaTime;
	fps: FrameRate;
}): SlipResult | null {
	const snappedClipDelta = mediaTime({
		ticks: roundFrameTicks({ ticks: requestedDelta, fps }),
	});
	const requestedSource = clipDeltaToSourceDelta({
		clipDelta: snappedClipDelta,
		retime: clip.retime,
	});
	// trimStart' = trimStart + d >= 0  and  trimEnd' = trimEnd - d >= 0
	// => d in [-trimStart, +trimEnd].
	const appliedSource = clampMediaTime({
		time: requestedSource,
		min: negateMediaTime({ time: clip.trimStart }),
		max: clip.trimEnd,
	});
	if (appliedSource === 0) {
		return null;
	}

	return {
		appliedSource,
		patch: {
			trimStart: addMediaTime({ a: clip.trimStart, b: appliedSource }),
			trimEnd: subMediaTime({ a: clip.trimEnd, b: appliedSource }),
		},
	};
}
