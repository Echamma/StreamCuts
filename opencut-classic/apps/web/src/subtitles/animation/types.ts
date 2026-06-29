/** Animation modes for word-by-word caption rendering. */
export const CAPTION_ANIMATION_MODES = [
	"none",
	"wordHighlight",
	"pop",
	"bounce",
	"typewriter",
	"karaokeLine",
] as const;

export type CaptionAnimationMode = (typeof CAPTION_ANIMATION_MODES)[number];

export function isCaptionAnimationMode(
	value: string,
): value is CaptionAnimationMode {
	return CAPTION_ANIMATION_MODES.some((mode) => mode === value);
}

/** Per-mode tuning. Kept loose (Partial) so callers only need to set what
 * differs from the renderer defaults. */
export interface CaptionAnimationConfig {
	mode: CaptionAnimationMode;
	/** Color to flip the active word to (wordHighlight, karaokeLine). */
	highlightColor?: string;
	/** Background color drawn behind the active word (wordHighlight pill). */
	highlightBackground?: string;
	/** Peak scale multiplier for the active word (pop, bounce). */
	peakScale?: number;
	/** How long after a word activates the peak holds, in seconds. */
	peakHoldSeconds?: number;
	/** Easing window length around the active edge, in seconds. */
	easeSeconds?: number;
}

export const DEFAULT_CAPTION_ANIMATION_CONFIG: CaptionAnimationConfig = {
	mode: "none",
	highlightColor: "#facc15",
	highlightBackground: "#000000",
	peakScale: 1.15,
	peakHoldSeconds: 0.08,
	easeSeconds: 0.08,
};

/** A timed word boundary inside a caption cue. Coordinates match the
 * caption cue: `start` is seconds from the timeline origin. */
export interface CaptionWord {
	text: string;
	start: number;
	end: number;
}

export interface CaptionCueWithWords {
	startTime: number;
	endTime: number;
	words: CaptionWord[];
}
