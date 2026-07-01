import { describe, expect, test } from "bun:test";
import {
	BAKED_CAPTION_PRESETS,
	findBakedPresetById,
} from "@/subtitles/animation/presets";
import {
	CAPTION_ANIMATION_MODES,
	isCaptionAnimationMode,
} from "@/subtitles/animation/types";

describe("baked caption presets", () => {
	test("includes six presets covering the plan's named looks", () => {
		const names = BAKED_CAPTION_PRESETS.map((p) => p.name).sort();
		expect(names).toEqual([
			"ASMR",
			"Beast",
			"Hormozi",
			"Reels",
			"Subtitle",
			"Words",
		]);
	});

	test("every preset id has the baked- prefix so they're easy to distinguish from user presets", () => {
		for (const preset of BAKED_CAPTION_PRESETS) {
			expect(preset.id.startsWith("baked-")).toBe(true);
		}
	});

	test("every preset animation.mode is a known mode", () => {
		for (const preset of BAKED_CAPTION_PRESETS) {
			expect(isCaptionAnimationMode(preset.animation.mode)).toBe(true);
		}
	});

	test("findBakedPresetById returns the preset by id", () => {
		const beast = findBakedPresetById({ id: "baked-beast" });
		expect(beast?.name).toBe("Beast");
		expect(beast?.animation.mode).toBe("wordHighlight");
	});

	test("findBakedPresetById returns null for unknown id", () => {
		expect(findBakedPresetById({ id: "nope" })).toBeNull();
	});

	test("Reels uses pop animation with peakScale > 1", () => {
		const reels = findBakedPresetById({ id: "baked-reels" });
		expect(reels?.animation.mode).toBe("pop");
		expect(reels?.animation.peakScale).toBeGreaterThan(1);
	});

	test("Subtitle and ASMR are static (no animation)", () => {
		expect(findBakedPresetById({ id: "baked-subtitle" })?.animation.mode).toBe(
			"none",
		);
		expect(findBakedPresetById({ id: "baked-asmr" })?.animation.mode).toBe(
			"none",
		);
	});
});

describe("CAPTION_ANIMATION_MODES", () => {
	test("matches the six modes named in the plan", () => {
		expect([...CAPTION_ANIMATION_MODES].sort()).toEqual([
			"bounce",
			"karaokeLine",
			"none",
			"pop",
			"typewriter",
			"wordHighlight",
		]);
	});

	test("isCaptionAnimationMode is true for each value, false otherwise", () => {
		for (const mode of CAPTION_ANIMATION_MODES) {
			expect(isCaptionAnimationMode(mode)).toBe(true);
		}
		expect(isCaptionAnimationMode("rainbow")).toBe(false);
	});
});
