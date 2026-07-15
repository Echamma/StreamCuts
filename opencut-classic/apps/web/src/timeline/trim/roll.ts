import type { FrameRate } from "opencut-wasm";
import type { MediaTime } from "@/wasm";
import {
	buildEdgeShiftPatches,
	edgeShiftBounds,
	isAdjacent,
	snapAndClampDelta,
} from "./shared";
import type { RollResult, TrimClip } from "./types";

/**
 * Roll: move the edit point shared by two adjacent clips. The left clip's
 * out-point and the right clip's in-point move together, so the combined span
 * `left.start … right.end` is unchanged — only the cut between them shifts.
 *
 * `requestedDelta` is a clip-space delta; positive moves the edit point later
 * (left clip grows, right clip shrinks). It is clamped to the available room —
 * the left clip's source tail vs the right clip's one-frame minimum going
 * forward, and the right clip's source head vs the left clip's minimum going
 * back — then frame-snapped.
 *
 * Returns `null` when the clips are not adjacent or the roll resolves to no
 * movement.
 */
export function computeRoll({
	left,
	right,
	requestedDelta,
	fps,
}: {
	left: TrimClip;
	right: TrimClip;
	requestedDelta: MediaTime;
	fps: FrameRate;
}): RollResult | null {
	if (!isAdjacent({ left, right })) {
		return null;
	}

	const { min, max } = edgeShiftBounds({ left, right, fps });
	const applied = snapAndClampDelta({ delta: requestedDelta, min, max, fps });
	if (applied === 0) {
		return null;
	}

	const patches = buildEdgeShiftPatches({ left, right, applied });
	return { applied, left: patches.left, right: patches.right };
}
