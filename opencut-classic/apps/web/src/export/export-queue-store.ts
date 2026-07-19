"use client";

import { useSyncExternalStore } from "react";
import type { EditorCore } from "@/core";
import { generateUUID } from "@/utils/id";
import {
	downloadBuffer,
	getExportFileExtension,
	getExportMimeType,
	type ExportOptions,
} from "@/export";
import {
	addJobToQueue,
	clearFinishedJobs,
	patchJob,
	removeJobFromQueue,
	runExportQueue,
	type ExportQueueJob,
} from "@/export/queue-runner";
import {
	loadQueueSnapshot,
	saveQueueSnapshot,
} from "@/export/queue-persistence";

interface ExportQueueSnapshot {
	jobs: ExportQueueJob[];
	isRunning: boolean;
}

let jobs: ExportQueueJob[] = [];
let isRunning = false;
let cancelRequested = false;
let snapshot: ExportQueueSnapshot = { jobs, isRunning };
const listeners = new Set<() => void>();

let hydratePromise: Promise<void> | null = null;

function commit(): void {
	snapshot = { jobs, isRunning };
	for (const listener of listeners) listener();
	// Fire-and-forget: persisting the snapshot must not block UI work; failures
	// are swallowed because a missing save is preferable to a UI hang.
	void saveQueueSnapshot({ jobs }).catch(() => {});
}

async function hydrateOnce(): Promise<void> {
	if (hydratePromise) return hydratePromise;
	hydratePromise = (async () => {
		try {
			const restored = await loadQueueSnapshot();
			if (restored.length === 0) return;
			// If a caller already added jobs while we were loading, merge — the
			// caller's fresh jobs come first so the persisted queue tails.
			jobs = [...jobs, ...restored];
			commit();
		} catch {
			// Ignore restore failures — a corrupt or missing DB is not a crash.
		}
	})();
	return hydratePromise;
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) {
		void hydrateOnce();
	}
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getSnapshot(): ExportQueueSnapshot {
	return snapshot;
}

const SERVER_SNAPSHOT: ExportQueueSnapshot = { jobs: [], isRunning: false };
function getServerSnapshot(): ExportQueueSnapshot {
	return SERVER_SNAPSHOT;
}

export function useExportQueue(): ExportQueueSnapshot {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function addExportJob({
	name,
	options,
}: {
	name: string;
	options: ExportOptions;
}): void {
	jobs = addJobToQueue({
		jobs,
		job: {
			id: generateUUID(),
			name,
			options,
			status: "pending",
			progress: 0,
		},
	});
	commit();
}

export function removeExportJob({ id }: { id: string }): void {
	jobs = removeJobFromQueue({ jobs, id });
	commit();
}

export function clearFinishedExportJobs(): void {
	jobs = clearFinishedJobs({ jobs });
	commit();
}

export function cancelExportQueue({ editor }: { editor: EditorCore }): void {
	cancelRequested = true;
	editor.project.cancelExport();
}

/** Run all pending jobs sequentially, each rendered to a buffer and downloaded,
 * so the queue can run unattended. No-op if a run is already in progress. */
export async function startExportQueue({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	if (isRunning) return;
	isRunning = true;
	cancelRequested = false;
	commit();

	// While a job runs, mirror the project's global export progress onto the
	// running job so the queue list shows live progress.
	const unsubscribe = editor.project.subscribe(() => {
		const state = editor.project.getExportState();
		if (!state.isExporting) return;
		const running = jobs.find((job) => job.status === "running");
		if (!running) return;
		jobs = patchJob({ jobs, id: running.id, patch: { progress: state.progress } });
		commit();
	});

	try {
		await runExportQueue({
			getJobs: () => jobs,
			runJob: ({ job }) =>
				editor.project.export({
					options: { ...job.options, outputTarget: { mode: "buffer" } },
				}),
			onJobStart: ({ id }) => {
				jobs = patchJob({ jobs, id, patch: { status: "running", progress: 0 } });
				commit();
			},
			onJobFinish: ({ id, status, error }) => {
				jobs = patchJob({ jobs, id, patch: { status, error } });
				commit();
			},
			onJobResult: ({ job, result }) => {
				if (!result.buffer) return;
				downloadBuffer({
					buffer: result.buffer,
					filename: `${job.name}${getExportFileExtension({ format: job.options.format })}`,
					mimeType: getExportMimeType({ format: job.options.format }),
				});
			},
			isCancelled: () => cancelRequested,
		});
	} finally {
		unsubscribe();
		isRunning = false;
		editor.project.clearExportState();
		commit();
	}
}
