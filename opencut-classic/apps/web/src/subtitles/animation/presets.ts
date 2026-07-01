import type { ParamValues } from "@/params";
import type { CaptionAnimationConfig } from "./types";

/** A baked-in caption style preset bundling text params with an animation
 * config. Seeded into the user's caption-style-presets store on first
 * load; users can fork/customize from there. */
export interface BakedCaptionPreset {
	id: string;
	name: string;
	description: string;
	params: Partial<ParamValues>;
	animation: CaptionAnimationConfig;
}

export const BAKED_CAPTION_PRESETS: BakedCaptionPreset[] = [
	{
		id: "baked-beast",
		name: "Beast",
		description: "Bold caps, yellow stroke, black bg pill, word-highlight.",
		params: {
			fontFamily: "Impact",
			fontWeight: "bold",
			color: "#ffffff",
			"background.enabled": true,
			"background.color": "#000000",
			"background.cornerRadius": 12,
			"background.paddingX": 32,
			"background.paddingY": 18,
		},
		animation: {
			mode: "wordHighlight",
			highlightColor: "#facc15",
			highlightBackground: "#000000",
		},
	},
	{
		id: "baked-reels",
		name: "Reels",
		description: "White pill bg, single-line, pop animation.",
		params: {
			fontFamily: "Arial",
			fontWeight: "bold",
			color: "#111111",
			"background.enabled": true,
			"background.color": "#ffffff",
			"background.cornerRadius": 18,
			"background.paddingX": 28,
			"background.paddingY": 14,
		},
		animation: {
			mode: "pop",
			peakScale: 1.18,
			peakHoldSeconds: 0.08,
			easeSeconds: 0.08,
		},
	},
	{
		id: "baked-hormozi",
		name: "Hormozi",
		description: "Caps + yellow active-word highlight.",
		params: {
			fontFamily: "Arial Black",
			fontWeight: "bold",
			color: "#ffffff",
			"background.enabled": false,
		},
		animation: {
			mode: "wordHighlight",
			highlightColor: "#facc15",
			highlightBackground: "transparent",
		},
	},
	{
		id: "baked-subtitle",
		name: "Subtitle",
		description: "Netflix-style bottom safe-area, no animation.",
		params: {
			fontFamily: "Helvetica",
			fontWeight: "normal",
			color: "#ffffff",
			"background.enabled": true,
			"background.color": "rgba(0,0,0,0.6)",
			"background.cornerRadius": 4,
			"background.paddingX": 18,
			"background.paddingY": 8,
		},
		animation: {
			mode: "none",
		},
	},
	{
		id: "baked-words",
		name: "Words",
		description: "TikTok one-word-at-a-time.",
		params: {
			fontFamily: "Arial",
			fontWeight: "bold",
			color: "#ffffff",
			"background.enabled": false,
		},
		animation: {
			mode: "typewriter",
		},
	},
	{
		id: "baked-asmr",
		name: "ASMR",
		description: "Small white, low opacity, no animation.",
		params: {
			fontFamily: "Helvetica",
			fontWeight: "normal",
			color: "#ffffff",
			opacity: 0.65,
			"background.enabled": false,
		},
		animation: {
			mode: "none",
		},
	},
];

export function findBakedPresetById({
	id,
}: {
	id: string;
}): BakedCaptionPreset | null {
	return BAKED_CAPTION_PRESETS.find((preset) => preset.id === id) ?? null;
}
