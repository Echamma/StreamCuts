import type { RetimeConfig } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

/**
 * The trim-relevant fields of a timeline element, in the units the trim math
 * operates on.
 *
 * `startTime` / `duration` are clip-space (timeline ticks); `trimStart` /
 * `trimEnd` / `sourceDuration` are source-space. The stored invariant these
 * satisfy — and which every trim operation here preserves — is
 * `trimStart + duration * rate + trimEnd === sourceDuration` (rate is `1` when
 * there is no retime). See `timeline/group-resize/compute-resize.ts` for the
 * same relationship on the resize path.
 */
export interface TrimClip {
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	/** Full source length. `undefined` for sourceless elements (text/graphic),
	 * which the math treats as having no source-extent limit. */
	sourceDuration?: MediaTime;
	retime?: RetimeConfig;
}

/**
 * A patch of trim fields for one element. Fields are optional so callers apply
 * only what an operation changed; the shape is a subset of `TimelineElement`
 * so it feeds straight into `UpdateElementsCommand`.
 */
export interface TrimPatch {
	startTime?: MediaTime;
	duration?: MediaTime;
	trimStart?: MediaTime;
	trimEnd?: MediaTime;
}

/** Result of {@link computeSlip}. */
export interface SlipResult {
	/** Source-space shift actually applied after clamping, signed. Positive
	 * reveals later source frames. */
	appliedSource: MediaTime;
	/** Patch for the slipped element (only `trimStart`/`trimEnd` change). */
	patch: TrimPatch;
}

/** Result of {@link computeRoll}. */
export interface RollResult {
	/** Clip-space delta actually applied after clamp + frame snap, signed.
	 * Positive moves the edit point later (left clip grows, right clip shrinks). */
	applied: MediaTime;
	/** Patch for the left clip of the edit point. */
	left: TrimPatch;
	/** Patch for the right clip of the edit point. */
	right: TrimPatch;
}

/** Result of {@link computeSlide}. */
export interface SlideResult {
	/** Clip-space delta actually applied after clamp + frame snap, signed.
	 * Positive slides the clip later. */
	applied: MediaTime;
	/** Patch for the left neighbour (absorbs the slide on its out-point). */
	left: TrimPatch;
	/** Patch for the slid clip itself (only `startTime` changes). */
	target: TrimPatch;
	/** Patch for the right neighbour (absorbs the slide on its in-point). */
	right: TrimPatch;
}
