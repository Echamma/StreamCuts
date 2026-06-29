import { describe, expect, test } from "bun:test";
import type { ExportOptions } from "@/export";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import {
	EXPORT_PLATFORM_PRESET_IDS,
	EXPORT_PRESETS,
	applyExportPreset,
	findMatchingPreset,
	getExportPreset,
	isExportPlatformPresetId,
	isExportPresetId,
} from "@/export/presets";

describe("EXPORT_PRESETS", () => {
	test("every platform preset id has a matching record", () => {
		for (const id of EXPORT_PLATFORM_PRESET_IDS) {
			const preset = EXPORT_PRESETS[id];
			expect(preset.id).toBe(id);
			expect(preset.width).toBeGreaterThan(0);
			expect(preset.height).toBeGreaterThan(0);
			expect(preset.fps.numerator).toBeGreaterThan(0);
			expect(preset.fps.denominator).toBeGreaterThan(0);
		}
	});

	test("vertical short-form presets are 1080x1920", () => {
		for (const id of [
			"tiktok-shorts",
			"instagram-reels",
			"youtube-shorts",
		] as const) {
			const preset = EXPORT_PRESETS[id];
			expect(preset.width).toBe(1080);
			expect(preset.height).toBe(1920);
		}
	});

	test("square preset is 1080x1080", () => {
		const preset = EXPORT_PRESETS["instagram-square"];
		expect(preset.width).toBe(1080);
		expect(preset.height).toBe(1080);
	});

	test("portrait preset is 1080x1350 (4:5)", () => {
		const preset = EXPORT_PRESETS["instagram-portrait"];
		expect(preset.width).toBe(1080);
		expect(preset.height).toBe(1350);
	});

	test("youtube-4k uses very_high quality", () => {
		expect(EXPORT_PRESETS["youtube-4k"].quality).toBe("very_high");
	});

	test("youtube-shorts uses 60 fps", () => {
		expect(EXPORT_PRESETS["youtube-shorts"].fps).toEqual({
			numerator: 60,
			denominator: 1,
		});
	});
});

describe("isExportPlatformPresetId / isExportPresetId", () => {
	test("rejects unknown ids", () => {
		expect(isExportPlatformPresetId("twitter")).toBe(false);
		expect(isExportPresetId("twitter")).toBe(false);
	});

	test("accepts known platform ids", () => {
		expect(isExportPlatformPresetId("tiktok-shorts")).toBe(true);
		expect(isExportPresetId("tiktok-shorts")).toBe(true);
	});

	test("custom is not a platform id but is a preset id", () => {
		expect(isExportPlatformPresetId("custom")).toBe(false);
		expect(isExportPresetId("custom")).toBe(true);
	});
});

describe("applyExportPreset", () => {
	test("overrides format, quality, fps, and canvas size", () => {
		const baseOptions: ExportOptions = {
			...DEFAULT_EXPORT_OPTIONS,
			fps: { numerator: 24, denominator: 1 },
		};
		const result = applyExportPreset({
			preset: getExportPreset({ id: "tiktok-shorts" }),
			options: baseOptions,
		});
		expect(result.format).toBe("mp4");
		expect(result.quality).toBe("high");
		expect(result.fps).toEqual({ numerator: 30, denominator: 1 });
		expect(result.canvasSizeOverride).toEqual({ width: 1080, height: 1920 });
	});

	test("preserves unrelated options like includeAudio and sceneTarget", () => {
		const baseOptions: ExportOptions = {
			...DEFAULT_EXPORT_OPTIONS,
			includeAudio: false,
			sceneTarget: { mode: "all" },
		};
		const result = applyExportPreset({
			preset: getExportPreset({ id: "instagram-square" }),
			options: baseOptions,
		});
		expect(result.includeAudio).toBe(false);
		expect(result.sceneTarget).toEqual({ mode: "all" });
	});
});

describe("findMatchingPreset", () => {
	test("returns the preset id when options match a preset exactly", () => {
		const preset = EXPORT_PRESETS["instagram-reels"];
		const options: ExportOptions = {
			format: preset.format,
			quality: preset.quality,
			fps: preset.fps,
			canvasSizeOverride: { width: preset.width, height: preset.height },
		};
		expect(findMatchingPreset({ options })).toBe("instagram-reels");
	});

	test("returns null when no canvasSizeOverride is set", () => {
		expect(findMatchingPreset({ options: DEFAULT_EXPORT_OPTIONS })).toBeNull();
	});

	test("returns null when fps differs", () => {
		const preset = EXPORT_PRESETS["tiktok-shorts"];
		const options: ExportOptions = {
			format: preset.format,
			quality: preset.quality,
			fps: { numerator: 60, denominator: 1 },
			canvasSizeOverride: { width: preset.width, height: preset.height },
		};
		expect(findMatchingPreset({ options })).toBeNull();
	});

	test("returns null when canvas size differs", () => {
		const preset = EXPORT_PRESETS["tiktok-shorts"];
		const options: ExportOptions = {
			format: preset.format,
			quality: preset.quality,
			fps: preset.fps,
			canvasSizeOverride: { width: 720, height: 1280 },
		};
		expect(findMatchingPreset({ options })).toBeNull();
	});
});
