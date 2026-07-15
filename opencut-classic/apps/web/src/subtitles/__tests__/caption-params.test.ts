import { describe, expect, test } from "bun:test";
import {
	CAPTION_PARAM_KEYS,
	captionAnimationConfigToParams,
	readCaptionAnimationConfig,
} from "@/subtitles/animation/params";
import { DEFAULT_CAPTION_ANIMATION_CONFIG } from "@/subtitles/animation/types";

describe("captionAnimationConfigToParams / readCaptionAnimationConfig", () => {
	test("round-trips a wordHighlight config through the param bag", () => {
		const config = {
			mode: "wordHighlight" as const,
			highlightColor: "#facc15",
			highlightBackground: "#000000",
		};
		const params = captionAnimationConfigToParams({ animation: config });
		expect(params[CAPTION_PARAM_KEYS.mode]).toBe("wordHighlight");
		expect(params[CAPTION_PARAM_KEYS.highlightColor]).toBe("#facc15");

		const read = readCaptionAnimationConfig({ params });
		expect(read.mode).toBe("wordHighlight");
		expect(read.highlightColor).toBe("#facc15");
		expect(read.highlightBackground).toBe("#000000");
	});

	test("missing params fall back to renderer defaults", () => {
		const read = readCaptionAnimationConfig({ params: {} });
		expect(read.mode).toBe("none");
		expect(read.highlightColor).toBe(
			DEFAULT_CAPTION_ANIMATION_CONFIG.highlightColor,
		);
		expect(read.peakScale).toBe(DEFAULT_CAPTION_ANIMATION_CONFIG.peakScale);
	});

	test("an unknown mode collapses to none rather than throwing", () => {
		const read = readCaptionAnimationConfig({
			params: { [CAPTION_PARAM_KEYS.mode]: "rainbow" },
		});
		expect(read.mode).toBe("none");
	});

	test("only set keys are emitted (no undefined noise)", () => {
		const params = captionAnimationConfigToParams({
			animation: { mode: "typewriter" },
		});
		expect(params).toEqual({ [CAPTION_PARAM_KEYS.mode]: "typewriter" });
	});
});
