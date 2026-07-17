import type { FrameRate } from "opencut-wasm";
import type {
	ExportFormat,
	ExportOptions,
	ExportQuality,
} from "./index";

const FPS_30: FrameRate = { numerator: 30, denominator: 1 };
const FPS_60: FrameRate = { numerator: 60, denominator: 1 };

export const EXPORT_PLATFORM_PRESET_IDS = [
	"tiktok-shorts",
	"instagram-reels",
	"youtube-shorts",
	"instagram-square",
	"instagram-portrait",
	"youtube-1080p",
	"youtube-4k",
] as const;

export type ExportPlatformPresetId = (typeof EXPORT_PLATFORM_PRESET_IDS)[number];

export const EXPORT_PRESET_IDS = [
	"custom",
	...EXPORT_PLATFORM_PRESET_IDS,
] as const;

/**
 * A preset id is one of: the sentinel `"custom"` (dialog is in manual mode), a
 * built-in `ExportPlatformPresetId`, or a `user:<uuid>` string for a user-saved
 * preset (DEL-004). We use a prefix instead of a discriminated union so old
 * ids continue to match `isExportPlatformPresetId` unchanged.
 */
export type ExportPresetId =
	| (typeof EXPORT_PRESET_IDS)[number]
	| UserExportPresetId;

export const USER_EXPORT_PRESET_ID_PREFIX = "user:" as const;
export type UserExportPresetId = `${typeof USER_EXPORT_PRESET_ID_PREFIX}${string}`;

export function isUserExportPresetId(value: string): value is UserExportPresetId {
	return value.startsWith(USER_EXPORT_PRESET_ID_PREFIX);
}

export interface ExportPreset {
	id: ExportPlatformPresetId;
	name: string;
	description: string;
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
}

/** A user-saved preset (DEL-004). Same shape as a built-in but freely edited. */
export interface UserExportPreset {
	id: UserExportPresetId;
	name: string;
	description: string;
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	createdAt: number;
}

export const EXPORT_PRESETS: Record<ExportPlatformPresetId, ExportPreset> = {
	"tiktok-shorts": {
		id: "tiktok-shorts",
		name: "TikTok",
		description: "Vertical 9:16 · 1080×1920 · 30 fps",
		width: 1080,
		height: 1920,
		fps: FPS_30,
		format: "mp4",
		quality: "high",
	},
	"instagram-reels": {
		id: "instagram-reels",
		name: "Instagram Reels",
		description: "Vertical 9:16 · 1080×1920 · 30 fps",
		width: 1080,
		height: 1920,
		fps: FPS_30,
		format: "mp4",
		quality: "high",
	},
	"youtube-shorts": {
		id: "youtube-shorts",
		name: "YouTube Shorts",
		description: "Vertical 9:16 · 1080×1920 · 60 fps",
		width: 1080,
		height: 1920,
		fps: FPS_60,
		format: "mp4",
		quality: "high",
	},
	"instagram-square": {
		id: "instagram-square",
		name: "Instagram Square",
		description: "Square 1:1 · 1080×1080 · 30 fps",
		width: 1080,
		height: 1080,
		fps: FPS_30,
		format: "mp4",
		quality: "high",
	},
	"instagram-portrait": {
		id: "instagram-portrait",
		name: "Instagram Portrait",
		description: "Portrait 4:5 · 1080×1350 · 30 fps",
		width: 1080,
		height: 1350,
		fps: FPS_30,
		format: "mp4",
		quality: "high",
	},
	"youtube-1080p": {
		id: "youtube-1080p",
		name: "YouTube 1080p",
		description: "Landscape 16:9 · 1920×1080 · 30 fps",
		width: 1920,
		height: 1080,
		fps: FPS_30,
		format: "mp4",
		quality: "high",
	},
	"youtube-4k": {
		id: "youtube-4k",
		name: "YouTube 4K",
		description: "Landscape 16:9 · 3840×2160 · 30 fps",
		width: 3840,
		height: 2160,
		fps: FPS_30,
		format: "mp4",
		quality: "very_high",
	},
};

export function isExportPlatformPresetId(
	value: string,
): value is ExportPlatformPresetId {
	return EXPORT_PLATFORM_PRESET_IDS.some((id) => id === value);
}

export function isExportPresetId(value: string): value is ExportPresetId {
	if (isUserExportPresetId(value)) return true;
	return EXPORT_PRESET_IDS.some((id) => id === value);
}

export function getExportPreset({
	id,
}: {
	id: ExportPlatformPresetId;
}): ExportPreset {
	return EXPORT_PRESETS[id];
}

export function applyExportPreset({
	preset,
	options,
}: {
	preset: ExportPreset | UserExportPreset;
	options: ExportOptions;
}): ExportOptions {
	return {
		...options,
		format: preset.format,
		quality: preset.quality,
		fps: preset.fps,
		canvasSizeOverride: { width: preset.width, height: preset.height },
	};
}

/**
 * Build a user preset record from a name + the current dialog state. `id` is
 * assigned by the store; `createdAt` records insertion order for stable sorting.
 */
export function buildUserExportPreset({
	id,
	name,
	options,
	fps,
	createdAt,
}: {
	id: UserExportPresetId;
	name: string;
	options: Pick<ExportOptions, "format" | "quality"> & {
		canvasSizeOverride?: { width: number; height: number };
	};
	fps: FrameRate;
	createdAt: number;
}): UserExportPreset {
	const width = options.canvasSizeOverride?.width ?? 1920;
	const height = options.canvasSizeOverride?.height ?? 1080;
	const fpsLabel =
		fps.denominator === 1
			? `${fps.numerator} fps`
			: `${(fps.numerator / fps.denominator).toFixed(2)} fps`;
	return {
		id,
		name,
		description: `${width}×${height} · ${fpsLabel}`,
		width,
		height,
		fps,
		format: options.format,
		quality: options.quality,
		createdAt,
	};
}

function isFrameRateEqual({
	a,
	b,
}: {
	a: FrameRate | undefined;
	b: FrameRate;
}): boolean {
	if (!a) return false;
	return a.numerator === b.numerator && a.denominator === b.denominator;
}

export function findMatchingPreset({
	options,
}: {
	options: ExportOptions;
}): ExportPlatformPresetId | null {
	const override = options.canvasSizeOverride;
	if (!override) return null;
	for (const id of EXPORT_PLATFORM_PRESET_IDS) {
		const preset = EXPORT_PRESETS[id];
		if (
			preset.format === options.format &&
			preset.quality === options.quality &&
			preset.width === override.width &&
			preset.height === override.height &&
			isFrameRateEqual({ a: options.fps, b: preset.fps })
		) {
			return id;
		}
	}
	return null;
}
