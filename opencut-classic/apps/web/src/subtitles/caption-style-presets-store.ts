"use client";

import { useSyncExternalStore } from "react";
import { generateUUID } from "@/utils/id";
import type { ParamValues } from "@/params";
import type { CaptionAnimationConfig } from "./animation/types";
import { BAKED_CAPTION_PRESETS } from "./animation/presets";

const STORAGE_KEY = "caption-style-presets";
const SEED_FLAG_KEY = "caption-style-presets-seeded";

export interface CaptionStylePreset {
	id: string;
	name: string;
	// Style params only — excludes content, transform, opacity, blendMode
	params: Partial<ParamValues>;
	/** Optional word-by-word animation. When absent, the preset renders as a
	 * static caption — backwards-compatible with v1 presets. */
	animation?: CaptionAnimationConfig;
}

let cachedPresets: CaptionStylePreset[] | null = null;
const listeners = new Set<() => void>();

function isValidPreset(value: unknown): value is CaptionStylePreset {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as CaptionStylePreset).id === "string" &&
		typeof (value as CaptionStylePreset).name === "string" &&
		typeof (value as CaptionStylePreset).params === "object"
	);
}

function readFromStorage(): CaptionStylePreset[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidPreset);
	} catch {
		return [];
	}
}

function writeToStorage({ presets }: { presets: CaptionStylePreset[] }): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

function getSnapshot(): CaptionStylePreset[] {
	cachedPresets ??= readFromStorage();
	return cachedPresets;
}

function getServerSnapshot(): CaptionStylePreset[] {
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

export function useCaptionStylePresets(): CaptionStylePreset[] {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function saveCaptionStylePreset({
	name,
	params,
}: {
	name: string;
	params: Partial<ParamValues>;
}): void {
	const current = getSnapshot();
	writeToStorage({
		presets: [...current, { id: generateUUID(), name, params }],
	});
	notify();
}

export function updateCaptionStylePreset({
	id,
	name,
	params,
}: {
	id: string;
	name?: string;
	params?: Partial<ParamValues>;
}): void {
	const current = getSnapshot();
	writeToStorage({
		presets: current.map((p) =>
			p.id === id
				? { ...p, ...(name !== undefined ? { name } : {}), ...(params !== undefined ? { params } : {}) }
				: p,
		),
	});
	notify();
}

export function deleteCaptionStylePreset({ id }: { id: string }): void {
	writeToStorage({ presets: getSnapshot().filter((p) => p.id !== id) });
	notify();
}

/** Seed the six baked presets into the user's preset list on first run.
 * Idempotent — the seed flag in localStorage prevents re-seeding even if the
 * user deletes some presets. Safe to call on every app load. */
export function seedBakedCaptionPresets(): void {
	if (typeof window === "undefined") return;
	if (localStorage.getItem(SEED_FLAG_KEY)) return;
	const existing = getSnapshot();
	const seeded: CaptionStylePreset[] = BAKED_CAPTION_PRESETS.map((p) => ({
		id: p.id,
		name: p.name,
		params: p.params,
		animation: p.animation,
	}));
	writeToStorage({ presets: [...seeded, ...existing] });
	localStorage.setItem(SEED_FLAG_KEY, "1");
	notify();
}
