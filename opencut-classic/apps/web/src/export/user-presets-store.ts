"use client";

import { useSyncExternalStore } from "react";
import { generateUUID } from "@/utils/id";
import {
	buildUserExportPreset,
	USER_EXPORT_PRESET_ID_PREFIX,
	type UserExportPreset,
	type UserExportPresetId,
} from "./presets";
import type { ExportOptions } from "./index";
import type { FrameRate } from "opencut-wasm";

const STORAGE_KEY = "export-user-presets";

let cachedPresets: UserExportPreset[] | null = null;
const listeners = new Set<() => void>();

function isValidPresetArray(value: unknown): value is UserExportPreset[] {
	if (!Array.isArray(value)) return false;
	return value.every(
		(item) =>
			typeof item === "object" &&
			item !== null &&
			typeof item.id === "string" &&
			item.id.startsWith(USER_EXPORT_PRESET_ID_PREFIX) &&
			typeof item.name === "string" &&
			typeof item.description === "string" &&
			typeof item.width === "number" &&
			typeof item.height === "number" &&
			typeof item.fps === "object" &&
			item.fps !== null &&
			typeof item.fps.numerator === "number" &&
			typeof item.fps.denominator === "number" &&
			(item.format === "mp4" ||
				item.format === "webm" ||
				item.format === "webm-av1") &&
			typeof item.quality === "string" &&
			typeof item.createdAt === "number",
	);
}

function readFromStorage(): UserExportPreset[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return isValidPresetArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeToStorage({ presets }: { presets: UserExportPreset[] }): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

function getSnapshot(): UserExportPreset[] {
	cachedPresets ??= readFromStorage();
	return cachedPresets;
}

function getServerSnapshot(): UserExportPreset[] {
	return [];
}

function notify(): void {
	cachedPresets = null;
	for (const listener of listeners) listener();
}

function onStorageChange(event: StorageEvent): void {
	if (event.key === STORAGE_KEY) notify();
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0 && typeof window !== "undefined") {
		window.addEventListener("storage", onStorageChange);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && typeof window !== "undefined") {
			window.removeEventListener("storage", onStorageChange);
		}
	};
}

export function useUserExportPresets(): UserExportPreset[] {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function getUserExportPreset({
	id,
}: {
	id: UserExportPresetId;
}): UserExportPreset | null {
	return getSnapshot().find((preset) => preset.id === id) ?? null;
}

export function saveUserExportPreset({
	name,
	options,
	fps,
}: {
	name: string;
	options: Pick<ExportOptions, "format" | "quality"> & {
		canvasSizeOverride?: { width: number; height: number };
	};
	fps: FrameRate;
}): UserExportPreset {
	const id: UserExportPresetId = `${USER_EXPORT_PRESET_ID_PREFIX}${generateUUID()}`;
	const preset = buildUserExportPreset({
		id,
		name: name.trim() || "Untitled preset",
		options,
		fps,
		createdAt: Date.now(),
	});
	const current = getSnapshot();
	writeToStorage({ presets: [...current, preset] });
	notify();
	return preset;
}

export function removeUserExportPreset({ id }: { id: UserExportPresetId }): void {
	writeToStorage({
		presets: getSnapshot().filter((preset) => preset.id !== id),
	});
	notify();
}

/** Test-only: reset the in-memory cache so a fresh read hits storage again. */
export function __resetUserExportPresetCache(): void {
	cachedPresets = null;
}
