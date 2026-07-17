import { describe, expect, test } from "bun:test";
import type { ExportOptions } from "@/export";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import {
	EXPORT_PLATFORM_PRESET_IDS,
	EXPORT_PRESETS,
	USER_EXPORT_PRESET_ID_PREFIX,
	applyExportPreset,
	buildUserExportPreset,
	findMatchingPreset,
	getExportPreset,
	isExportPlatformPresetId,
	isExportPresetId,
	isUserExportPresetId,
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
		const preset = EXPORT_PRESETS["youtube-1080p"];
		const options: ExportOptions = {
			format: preset.format,
			quality: preset.quality,
			fps: preset.fps,
			canvasSizeOverride: { width: preset.width, height: preset.height },
		};
		expect(findMatchingPreset({ options })).toBe("youtube-1080p");
	});

	test("returns null when no canvasSizeOverride is set", () => {
		expect(findMatchingPreset({ options: DEFAULT_EXPORT_OPTIONS })).toBeNull();
	});

	test("returns null when fps differs from every preset at the same canvas size", () => {
		const preset = EXPORT_PRESETS["instagram-square"];
		const options: ExportOptions = {
			format: preset.format,
			quality: preset.quality,
			fps: { numerator: 24, denominator: 1 },
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

	test("with two identical-spec presets, returns the first one in declaration order", () => {
		// tiktok-shorts and instagram-reels share identical specs by design; matching
		// is canonical to the first-declared so the dropdown shows a stable selection.
		const preset = EXPORT_PRESETS["instagram-reels"];
		const options: ExportOptions = {
			format: preset.format,
			quality: preset.quality,
			fps: preset.fps,
			canvasSizeOverride: { width: preset.width, height: preset.height },
		};
		expect(findMatchingPreset({ options })).toBe("tiktok-shorts");
	});
});

describe("isUserExportPresetId / isExportPresetId (DEL-004)", () => {
	test("prefixed ids are user preset ids", () => {
		expect(isUserExportPresetId(`${USER_EXPORT_PRESET_ID_PREFIX}abcd-1234`)).toBe(
			true,
		);
	});

	test("built-in ids are not user preset ids", () => {
		expect(isUserExportPresetId("custom")).toBe(false);
		expect(isUserExportPresetId("tiktok-shorts")).toBe(false);
	});

	test("isExportPresetId accepts user preset ids", () => {
		expect(isExportPresetId(`${USER_EXPORT_PRESET_ID_PREFIX}deadbeef`)).toBe(true);
	});
});

describe("buildUserExportPreset (DEL-004)", () => {
	test("copies format/quality/fps and derives description from size + fps", () => {
		const preset = buildUserExportPreset({
			id: `${USER_EXPORT_PRESET_ID_PREFIX}p1`,
			name: "My square 60",
			options: {
				format: "mp4",
				quality: "high",
				canvasSizeOverride: { width: 1080, height: 1080 },
			},
			fps: { numerator: 60, denominator: 1 },
			createdAt: 1_700_000_000_000,
		});
		expect(preset.id).toBe(`${USER_EXPORT_PRESET_ID_PREFIX}p1`);
		expect(preset.name).toBe("My square 60");
		expect(preset.width).toBe(1080);
		expect(preset.height).toBe(1080);
		expect(preset.fps.numerator).toBe(60);
		expect(preset.format).toBe("mp4");
		expect(preset.quality).toBe("high");
		expect(preset.description).toContain("1080×1080");
		expect(preset.description).toContain("60");
	});

	test("falls back to 1920×1080 when no canvasSizeOverride is given", () => {
		const preset = buildUserExportPreset({
			id: `${USER_EXPORT_PRESET_ID_PREFIX}p2`,
			name: "Untitled",
			options: { format: "webm", quality: "medium" },
			fps: { numerator: 30, denominator: 1 },
			createdAt: 0,
		});
		expect(preset.width).toBe(1920);
		expect(preset.height).toBe(1080);
	});

	test("applyExportPreset accepts a user preset", () => {
		const userPreset = buildUserExportPreset({
			id: `${USER_EXPORT_PRESET_ID_PREFIX}p3`,
			name: "Odd",
			options: {
				format: "webm",
				quality: "medium",
				canvasSizeOverride: { width: 720, height: 720 },
			},
			fps: { numerator: 24, denominator: 1 },
			createdAt: 0,
		});
		const options: ExportOptions = {
			...DEFAULT_EXPORT_OPTIONS,
			includeAudio: false,
		};
		const result = applyExportPreset({ preset: userPreset, options });
		expect(result.canvasSizeOverride).toEqual({ width: 720, height: 720 });
		expect(result.format).toBe("webm");
		expect(result.quality).toBe("medium");
		expect(result.includeAudio).toBe(false);
	});
});
