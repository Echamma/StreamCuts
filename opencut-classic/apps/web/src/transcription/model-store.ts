"use client";

import { useSyncExternalStore } from "react";
import {
	DEFAULT_BACKEND_TRANSCRIPTION_MODEL,
	isKnownBackendModel,
} from "./backend-models";

const STORAGE_KEY = "transcription-model";

let cachedModel: string | null = null;
const listeners = new Set<() => void>();

function readFromStorage(): string {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw && isKnownBackendModel(raw)) return raw;
	} catch {
		// Ignore storage access failures (private mode, disabled storage, etc.).
	}
	return DEFAULT_BACKEND_TRANSCRIPTION_MODEL;
}

function getSnapshot(): string {
	cachedModel ??= readFromStorage();
	return cachedModel;
}

function getServerSnapshot(): string {
	return DEFAULT_BACKEND_TRANSCRIPTION_MODEL;
}

function notify(): void {
	for (const listener of listeners) listener();
}

function onStorageChange(event: StorageEvent): void {
	if (event.key === STORAGE_KEY) {
		cachedModel = readFromStorage();
		notify();
	}
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

export function useSelectedTranscriptionModel(): string {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setSelectedTranscriptionModel({
	model,
}: {
	model: string;
}): void {
	cachedModel = model;
	try {
		localStorage.setItem(STORAGE_KEY, model);
	} catch {
		// Keep the in-memory selection even if it can't be persisted.
	}
	notify();
}
