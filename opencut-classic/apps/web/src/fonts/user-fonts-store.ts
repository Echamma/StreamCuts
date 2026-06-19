"use client";

import { useSyncExternalStore } from "react";
import { generateUUID } from "@/utils/id";

const DB_NAME = "video-editor-user-fonts";
const STORE_NAME = "fonts";

export interface UserFontMeta {
	id: string;
	name: string;
	format: string;
}

interface UserFontRecord extends UserFontMeta {
	data: ArrayBuffer;
}

// In-memory metadata cache — binary data stays in IndexedDB until needed
let cachedMetas: UserFontMeta[] | null = null;
let loadPromise: Promise<void> | null = null;
const registeredFontNames = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) {
		// Trigger initial load on first subscriber
		void ensureLoaded();
	}
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getSnapshot(): UserFontMeta[] {
	return cachedMetas ?? [];
}

function getServerSnapshot(): UserFontMeta[] {
	return [];
}

export function useUserFonts(): UserFontMeta[] {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

async function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onerror = () => reject(req.error);
		req.onsuccess = () => resolve(req.result);
		req.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: "id" });
			}
		};
	});
}

async function getAllRecords(): Promise<UserFontRecord[]> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction([STORE_NAME], "readonly");
		const req = tx.objectStore(STORE_NAME).getAll();
		req.onsuccess = () => resolve(req.result ?? []);
		req.onerror = () => reject(req.error);
	});
}

async function registerFontFace({
	name,
	data,
	format,
}: {
	name: string;
	data: ArrayBuffer;
	format: string;
}): Promise<void> {
	if (registeredFontNames.has(name)) return;
	const face = new FontFace(name, data, { style: "normal", weight: "400 700" });
	await face.load();
	document.fonts.add(face);
	registeredFontNames.add(name);
}

async function ensureLoaded(): Promise<void> {
	if (cachedMetas !== null) return;
	if (loadPromise) return loadPromise;

	loadPromise = (async () => {
		try {
			const records = await getAllRecords();
			await Promise.all(records.map((r) => registerFontFace(r)));
			cachedMetas = records.map(({ id, name, format }) => ({
				id,
				name,
				format,
			}));
		} catch {
			cachedMetas = [];
		}
		notify();
	})();

	return loadPromise;
}

export async function loadAllUserFonts(): Promise<void> {
	await ensureLoaded();
}

export async function addUserFont({
	name,
	data,
	format,
}: {
	name: string;
	data: ArrayBuffer;
	format: string;
}): Promise<void> {
	const id = generateUUID();
	const record: UserFontRecord = { id, name, format, data };

	const db = await openDB();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction([STORE_NAME], "readwrite");
		const req = tx.objectStore(STORE_NAME).put(record);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});

	await registerFontFace({ name, data, format });

	cachedMetas = [...(cachedMetas ?? []), { id, name, format }];
	notify();
}

export async function removeUserFont({ id }: { id: string }): Promise<void> {
	const meta = (cachedMetas ?? []).find((m) => m.id === id);

	const db = await openDB();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction([STORE_NAME], "readwrite");
		const req = tx.objectStore(STORE_NAME).delete(id);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});

	if (meta) {
		// Remove from document.fonts
		for (const face of document.fonts) {
			if (face.family === meta.name || face.family === `"${meta.name}"`) {
				document.fonts.delete(face);
			}
		}
		registeredFontNames.delete(meta.name);
	}

	cachedMetas = (cachedMetas ?? []).filter((m) => m.id !== id);
	notify();
}
