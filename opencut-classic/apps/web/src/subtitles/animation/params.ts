import type { ParamValue, ParamValues } from "@/params";
import {
	DEFAULT_CAPTION_ANIMATION_CONFIG,
	isCaptionAnimationMode,
	type CaptionAnimationConfig,
} from "./types";

/** Dotted param keys that carry a caption's word-by-word animation config.
 * Stored in the flat `TextElement.params` bag alongside `background.*` keys so
 * the existing preset save/apply + updateElements plumbing round-trips them for
 * free (params only hold primitives — arrays like word timings live on the
 * element itself, not here). */
export const CAPTION_PARAM_KEYS = {
	mode: "caption.mode",
	highlightColor: "caption.highlightColor",
	highlightBackground: "caption.highlightBackground",
	peakScale: "caption.peakScale",
	peakHoldSeconds: "caption.peakHoldSeconds",
	easeSeconds: "caption.easeSeconds",
} as const;

/** The style-panel keys that make up a caption animation. Exposed so the panel
 * can include them when saving "current style as preset". */
export const CAPTION_ANIMATION_PARAM_KEY_LIST: readonly string[] =
	Object.values(CAPTION_PARAM_KEYS);

function readString({
	params,
	key,
}: {
	params: Partial<ParamValues>;
	key: string;
}): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function readNumber({
	params,
	key,
}: {
	params: Partial<ParamValues>;
	key: string;
}): number | undefined {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** Reconstruct a `CaptionAnimationConfig` from an element's flat param bag.
 * Unknown or missing values fall back to the renderer defaults, and an
 * unrecognised mode collapses to "none" so old/foreign params render statically
 * rather than throwing. */
export function readCaptionAnimationConfig({
	params,
}: {
	params: Partial<ParamValues>;
}): CaptionAnimationConfig {
	const rawMode = readString({ params, key: CAPTION_PARAM_KEYS.mode });
	const mode =
		rawMode !== undefined && isCaptionAnimationMode(rawMode)
			? rawMode
			: DEFAULT_CAPTION_ANIMATION_CONFIG.mode;

	return {
		mode,
		highlightColor:
			readString({ params, key: CAPTION_PARAM_KEYS.highlightColor }) ??
			DEFAULT_CAPTION_ANIMATION_CONFIG.highlightColor,
		highlightBackground:
			readString({ params, key: CAPTION_PARAM_KEYS.highlightBackground }) ??
			DEFAULT_CAPTION_ANIMATION_CONFIG.highlightBackground,
		peakScale:
			readNumber({ params, key: CAPTION_PARAM_KEYS.peakScale }) ??
			DEFAULT_CAPTION_ANIMATION_CONFIG.peakScale,
		peakHoldSeconds:
			readNumber({ params, key: CAPTION_PARAM_KEYS.peakHoldSeconds }) ??
			DEFAULT_CAPTION_ANIMATION_CONFIG.peakHoldSeconds,
		easeSeconds:
			readNumber({ params, key: CAPTION_PARAM_KEYS.easeSeconds }) ??
			DEFAULT_CAPTION_ANIMATION_CONFIG.easeSeconds,
	};
}

/** Flatten a `CaptionAnimationConfig` into dotted param keys so a baked preset's
 * typed `animation` block can be merged into a text element via the normal
 * params update path. Only keys that are actually set are emitted. */
export function captionAnimationConfigToParams({
	animation,
}: {
	animation: CaptionAnimationConfig;
}): Partial<ParamValues> {
	const params: Record<string, ParamValue> = {
		[CAPTION_PARAM_KEYS.mode]: animation.mode,
	};
	if (animation.highlightColor !== undefined) {
		params[CAPTION_PARAM_KEYS.highlightColor] = animation.highlightColor;
	}
	if (animation.highlightBackground !== undefined) {
		params[CAPTION_PARAM_KEYS.highlightBackground] =
			animation.highlightBackground;
	}
	if (animation.peakScale !== undefined) {
		params[CAPTION_PARAM_KEYS.peakScale] = animation.peakScale;
	}
	if (animation.peakHoldSeconds !== undefined) {
		params[CAPTION_PARAM_KEYS.peakHoldSeconds] = animation.peakHoldSeconds;
	}
	if (animation.easeSeconds !== undefined) {
		params[CAPTION_PARAM_KEYS.easeSeconds] = animation.easeSeconds;
	}
	return params;
}
