import type { FrameRate } from "opencut-wasm";
import { addMediaTime, type MediaTime } from "@/wasm";
import {
	buildEdgeShiftPatches,
	edgeShiftBounds,
	isAdjacent,
	snapAndClampDelta,
} from "./shared";
import type { SlideResult, TrimClip } from "./types";

/**
 * Slide: move a clip along the timeline while its two neighbours absorb the
 * change — the left neighbour extends/retracts on its out-point and the right
 * neighbour on its in-point. The slid clip keeps its own source window and
 * duration; only its `startTime` changes. The outer span
 * `left.start … right.end` is unchanged, so the layout stays gapless.
 *
 * `requestedDelta` is a clip-space delta; positive slides the clip later. The
 * bounds are identical to a roll across the left→right edit point (the slid clip
 * in the middle keeps its duration and simply rides between them).
 *
 * Requires both neighbours to be immediately adjacent to the target; returns
 * `null` otherwise, or when the slide resolves to no movement. Callers wanting
 * to move a clip without adjacent neighbours should use a plain move instead.
 */
export function computeSlide({
	left,
	target,
	right,
	requestedDelta,
	fps,
}: {
	left: TrimClip;
	target: TrimClip;
	right: TrimClip;
	requestedDelta: MediaTime;
	fps: FrameRate;
}): SlideResult | null {
	if (!isAdjacent({ left, right: target }) || !isAdjacent({ left: target, right })) {
		return null;
	}

	const { min, max } = edgeShiftBounds({ left, right, fps });
	const applied = snapAndClampDelta({ delta: requestedDelta, min, max, fps });
	if (applied === 0) {
		return null;
	}

	const patches = buildEdgeShiftPatches({ left, right, applied });
	return {
		applied,
		left: patches.left,
		target: { startTime: addMediaTime({ a: target.startTime, b: applied }) },
		right: patches.right,
	};
}
