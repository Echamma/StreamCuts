import type { AudioCapableElement } from "@/timeline/audio-state";

/**
 * Per-clip fade in/out (FAIR-003). The two fade times live in
 * `element.params.fadeIn` / `element.params.fadeOut` as seconds; absent (every
 * pre-existing element) means no fade, a byte-for-byte no-op on the mix and
 * playback graphs.
 *
 * The fade math is a linear ramp:
 *   [0, fadeIn)                → t / fadeIn  (attack)
 *   [duration - fadeOut, dur]  → (duration - t) / fadeOut  (release)
 *   otherwise                  → 1
 * Overlapping fades (fadeIn + fadeOut > duration) are handled by taking the
 * smaller of the two factors, so the clip never overshoots unity.
 */

export const FADE_MIN_SECONDS = 0;
/** Practical UI upper bound; longer fades are still legal via keyframes later. */
export const FADE_MAX_SECONDS = 30;

/** Clamp a fade duration to `[0, FADE_MAX_SECONDS]`; non-finite → 0. */
export function clampFadeSeconds({ value }: { value: number }): number {
	if (!Number.isFinite(value)) {
		return FADE_MIN_SECONDS;
	}
	return Math.min(FADE_MAX_SECONDS, Math.max(FADE_MIN_SECONDS, value));
}

/** Read `params.fadeIn` off an element; default 0. Returned in seconds. */
export function getElementFadeIn({
	element,
}: {
	element: AudioCapableElement;
}): number {
	const value = element.params.fadeIn;
	return typeof value === "number" ? clampFadeSeconds({ value }) : 0;
}

/** Read `params.fadeOut` off an element; default 0. Returned in seconds. */
export function getElementFadeOut({
	element,
}: {
	element: AudioCapableElement;
}): number {
	const value = element.params.fadeOut;
	return typeof value === "number" ? clampFadeSeconds({ value }) : 0;
}

/**
 * Envelope multiplier at `localTime` (seconds from clip start) for a clip that
 * fades in over `fadeIn` seconds and fades out during the last `fadeOut`
 * seconds of its `duration` (also seconds). Result is in `[0, 1]`.
 *
 * `localTime` outside `[0, duration]` clamps to the nearest endpoint (0 for
 * negative, 0 for past-end because the fade-out has finished). `duration <= 0`
 * yields 0 (nothing to sound).
 */
export function computeFadeGain({
	fadeIn,
	fadeOut,
	duration,
	localTime,
}: {
	fadeIn: number;
	fadeOut: number;
	duration: number;
	localTime: number;
}): number {
	if (duration <= 0) return 0;
	if (localTime < 0) return 0;
	if (localTime > duration) return 0;

	const attack = fadeIn > 0 ? Math.min(1, localTime / fadeIn) : 1;
	const release =
		fadeOut > 0 ? Math.min(1, (duration - localTime) / fadeOut) : 1;
	return Math.min(attack, release);
}
