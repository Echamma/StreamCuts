import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	__resetUserExportPresetCache,
	getUserExportPreset,
	removeUserExportPreset,
	saveUserExportPreset,
} from "@/export/user-presets-store";
import type { UserExportPresetId } from "@/export/presets";
import { USER_EXPORT_PRESET_ID_PREFIX } from "@/export/presets";

// The store reads/writes localStorage. Bun's testing globals include a stub for
// window.localStorage; if it's missing we fall back to a minimal in-memory
// polyfill so the tests never touch a real browser store.
function ensureLocalStorage(): void {
	if (typeof globalThis.localStorage !== "undefined") return;
	const backing = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (key: string) => backing.get(key) ?? null,
			setItem: (key: string, value: string) => backing.set(key, value),
			removeItem: (key: string) => backing.delete(key),
			clear: () => backing.clear(),
			key: () => null,
			length: 0,
		},
		configurable: true,
	});
}

describe("user-presets-store (DEL-004)", () => {
	beforeEach(() => {
		ensureLocalStorage();
		globalThis.localStorage.clear();
		__resetUserExportPresetCache();
	});

	afterEach(() => {
		globalThis.localStorage.clear();
		__resetUserExportPresetCache();
	});

	test("save + get round-trips through storage", () => {
		const preset = saveUserExportPreset({
			name: "Instagram widescreen",
			options: {
				format: "mp4",
				quality: "high",
				canvasSizeOverride: { width: 1920, height: 1080 },
			},
			fps: { numerator: 30, denominator: 1 },
		});
		expect(preset.id).toMatch(
			new RegExp(`^${USER_EXPORT_PRESET_ID_PREFIX.replace(":", "\\:")}`),
		);
		expect(preset.name).toBe("Instagram widescreen");

		__resetUserExportPresetCache();
		const fetched = getUserExportPreset({ id: preset.id });
		expect(fetched?.width).toBe(1920);
		expect(fetched?.height).toBe(1080);
	});

	test("empty name falls back to 'Untitled preset'", () => {
		const preset = saveUserExportPreset({
			name: "   ",
			options: {
				format: "mp4",
				quality: "high",
				canvasSizeOverride: { width: 1080, height: 1080 },
			},
			fps: { numerator: 30, denominator: 1 },
		});
		expect(preset.name).toBe("Untitled preset");
	});

	test("remove drops the preset from storage", () => {
		const a = saveUserExportPreset({
			name: "A",
			options: {
				format: "mp4",
				quality: "high",
				canvasSizeOverride: { width: 800, height: 600 },
			},
			fps: { numerator: 30, denominator: 1 },
		});
		const b = saveUserExportPreset({
			name: "B",
			options: {
				format: "mp4",
				quality: "high",
				canvasSizeOverride: { width: 1600, height: 900 },
			},
			fps: { numerator: 30, denominator: 1 },
		});
		removeUserExportPreset({ id: a.id });
		__resetUserExportPresetCache();
		expect(getUserExportPreset({ id: a.id })).toBeNull();
		expect(getUserExportPreset({ id: b.id })?.name).toBe("B");
	});

	test("corrupted storage returns empty and does not throw", () => {
		globalThis.localStorage.setItem("export-user-presets", "not-json");
		__resetUserExportPresetCache();
		const preset = getUserExportPreset({
			id: `${USER_EXPORT_PRESET_ID_PREFIX}anything` as UserExportPresetId,
		});
		expect(preset).toBeNull();
	});
});
