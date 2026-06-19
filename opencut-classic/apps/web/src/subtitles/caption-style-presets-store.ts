"use client";

import { useSyncExternalStore } from "react";
import { generateUUID } from "@/utils/id";
import type { ParamValues } from "@/params";

const STORAGE_KEY = "caption-style-presets";

export interface CaptionStylePreset {
	id: string;
	name: string;
	// Style params only — excludes content, transform, opacity, blendMode
	params: Partial<ParamValues>;
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
