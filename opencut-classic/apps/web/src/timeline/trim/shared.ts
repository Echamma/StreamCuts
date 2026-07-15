import type { FrameRate } from "opencut-wasm";
// Import from the concrete retime module rather than the `@/retime` barrel: the
// barrel re-exports `audio-stretch`, which pulls in `soundtouchjs`, a runtime
// dependency this pure math has no need for. Both helpers live in `resolve`.
import {
	getSourceTimeAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime/resolve";
import {
	addMediaTime,
	clampMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	minMediaTime,
	roundFrameTicks,
	roundMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import type { TrimClip, TrimPatch } from "./types";

/** One video frame in ticks — the minimum clip duration, matching the resize
 * path (`compute-resize.ts`). */
export function minFrameDuration({ fps }: { fps: FrameRate }): MediaTime {
	return mediaTime({
		ticks: Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator),
	});
}

/** Negate a `MediaTime` while keeping the brand. */
export function negateMediaTime({ time }: { time: MediaTime }): MediaTime {
	return subMediaTime({ a: ZERO_MEDIA_TIME, b: time });
}

/** Whether `left` ends exactly where `right` begins (they share an edit point,
 * with no gap and no overlap). Roll and slide are only defined across such a
 * shared boundary. */
export function isAdjacent({
	left,
	right,
}: {
	left: Pick<TrimClip, "startTime" | "duration">;
	right: Pick<TrimClip, "startTime">;
}): boolean {
	return addMediaTime({ a: left.startTime, b: left.duration }) === right.startTime;
}

/** Clamp a `MediaTime` up to zero (`< 0` becomes `0`). */
function clampLowZero({ time }: { time: MediaTime }): MediaTime {
	return maxMediaTime({ a: ZERO_MEDIA_TIME, b: time });
}

/**
 * Convert a clip-space delta into the signed source-space delta it represents.
 * With no retime this is the identity; with a constant rate it scales and
 * rounds once (mirrors `getSourceDeltaForClipDelta` in `compute-resize.ts`).
 */
export function clipDeltaToSourceDelta({
	clipDelta,
	retime,
}: {
	clipDelta: MediaTime;
	retime?: TrimClip["retime"];
}): MediaTime {
	if (!retime) {
		return clipDelta;
	}
	return roundMediaTime({
		time: getSourceTimeAtClipTime({ clipTime: clipDelta, retime }),
	});
}

/**
 * Clip-space room to reveal more of the source at the given side, i.e. how far
 * a trimmed-off head (`trimStart`) or tail (`trimEnd`) can be pushed back onto
 * the timeline. `null` means unbounded — the element has no known source extent
 * (`sourceDuration` is `undefined`), matching how resize treats such elements.
 *
 * Floors rather than rounds so a fractional retimed conversion can never claim
 * room the source does not actually have.
 */
export function sourceRoomClip({
	clip,
	side,
}: {
	clip: TrimClip;
	side: "start" | "end";
}): MediaTime | null {
	if (clip.sourceDuration == null) {
		return null;
	}
	const sourceSpan = side === "start" ? clip.trimStart : clip.trimEnd;
	return mediaTime({
		ticks: Math.floor(
			getTimelineDurationForSourceSpan({ sourceSpan, retime: clip.retime }),
		),
	});
}

/** Clip-space room to shrink a clip down to the one-frame minimum. */
export function shrinkRoomClip({
	clip,
	minDuration,
}: {
	clip: TrimClip;
	minDuration: MediaTime;
}): MediaTime {
	return clampLowZero({ time: subMediaTime({ a: clip.duration, b: minDuration }) });
}

/**
 * Bounds (clip-space, signed) for shifting the shared edge between two adjacent
 * clips — the common core of roll and slide.
 *
 * Positive delta grows `left` on its out-point (limited by `left`'s source
 * tail) and shrinks `right` (limited by `right`'s one-frame minimum). Negative
 * delta shrinks `left` (its minimum) and grows `right` on its in-point (limited
 * by `right`'s source head). A `null` source room means that side is bounded
 * only by the neighbour's minimum duration.
 */
export function edgeShiftBounds({
	left,
	right,
	fps,
}: {
	left: TrimClip;
	right: TrimClip;
	fps: FrameRate;
}): { min: MediaTime; max: MediaTime } {
	const minDuration = minFrameDuration({ fps });

	const leftTailRoom = sourceRoomClip({ clip: left, side: "end" });
	const rightShrinkRoom = shrinkRoomClip({ clip: right, minDuration });
	const posRoom = clampLowZero({
		time:
			leftTailRoom === null
				? rightShrinkRoom
				: minMediaTime({ a: leftTailRoom, b: rightShrinkRoom }),
	});

	const leftShrinkRoom = shrinkRoomClip({ clip: left, minDuration });
	const rightHeadRoom = sourceRoomClip({ clip: right, side: "start" });
	const negRoom = clampLowZero({
		time:
			rightHeadRoom === null
				? leftShrinkRoom
				: minMediaTime({ a: leftShrinkRoom, b: rightHeadRoom }),
	});

	return { min: negateMediaTime({ time: negRoom }), max: posRoom };
}

/**
 * Build the left/right element patches for an edge shift of `applied` clip-space
 * ticks — shared by roll and slide, which move a shared boundary identically.
 * The left clip is extended/retracted on its out-point and the right clip on its
 * in-point, so their combined outer span is unchanged. Each side's source delta
 * is derived from the same `applied` value, keeping both per-element invariants
 * (`trimStart + duration * rate + trimEnd === sourceDuration`) intact.
 */
export function buildEdgeShiftPatches({
	left,
	right,
	applied,
}: {
	left: TrimClip;
	right: TrimClip;
	applied: MediaTime;
}): { left: TrimPatch; right: TrimPatch } {
	const leftSourceDelta = clipDeltaToSourceDelta({
		clipDelta: applied,
		retime: left.retime,
	});
	const rightSourceDelta = clipDeltaToSourceDelta({
		clipDelta: applied,
		retime: right.retime,
	});
	return {
		left: {
			duration: addMediaTime({ a: left.duration, b: applied }),
			trimEnd: clampLowZero({
				time: subMediaTime({ a: left.trimEnd, b: leftSourceDelta }),
			}),
		},
		right: {
			startTime: addMediaTime({ a: right.startTime, b: applied }),
			duration: subMediaTime({ a: right.duration, b: applied }),
			trimStart: clampLowZero({
				time: addMediaTime({ a: right.trimStart, b: rightSourceDelta }),
			}),
		},
	};
}

/**
 * Clamp a requested clip-space delta into `[min, max]`, snap it to a frame, then
 * re-clamp. Re-clamping after the snap honours the source/neighbour bound over
 * frame alignment (you cannot extend past real content) — the exact discipline
 * `compute-resize.ts` uses.
 */
export function snapAndClampDelta({
	delta,
	min,
	max,
	fps,
}: {
	delta: MediaTime;
	min: MediaTime;
	max: MediaTime;
	fps: FrameRate;
}): MediaTime {
	const clamped = clampMediaTime({ time: delta, min, max });
	const snapped = mediaTime({ ticks: roundFrameTicks({ ticks: clamped, fps }) });
	return clampMediaTime({ time: snapped, min, max });
}
