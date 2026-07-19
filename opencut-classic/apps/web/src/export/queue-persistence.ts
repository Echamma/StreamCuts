import type { ExportQueueJob } from "./queue-runner";

/**
 * IndexedDB persistence for the export queue (DEL-001). The queue itself is
 * kept alive in-memory by `export-queue-store.ts`; this module is only
 * responsible for the *saved* copy: one KV record under key `queue` holding
 * the array of jobs the user hasn't finished yet.
 *
 * Design constraints:
 * - Serializable only: `outputTarget` is stripped before write (its `writable`
 *   field is a live `FileSystemWritableFileStream` and is queue-runtime state,
 *   not persisted state).
 * - Finished jobs are dropped on save — a reload should not resurrect a
 *   completed download's history.
 * - Interrupted `running` jobs demote to `pending` on load so a browser crash
 *   mid-render re-queues the job for the next run rather than losing it.
 */

const DB_NAME = "video-editor-export-queue";
const DB_VERSION = 1;
const STORE_NAME = "queue-state";
const RECORD_KEY = "queue";

interface QueueRecord {
	key: typeof RECORD_KEY;
	jobs: ExportQueueJob[];
}

async function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onerror = () => reject(req.error);
		req.onsuccess = () => resolve(req.result);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: "key" });
			}
		};
	});
}

function isQueueRecord(value: unknown): value is QueueRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { key?: unknown }).key === RECORD_KEY &&
		Array.isArray((value as { jobs?: unknown }).jobs)
	);
}

/** Strip fields that would be either non-serializable or misleading on reload. */
function sanitizeForPersistence({
	jobs,
}: {
	jobs: ExportQueueJob[];
}): ExportQueueJob[] {
	return jobs
		.filter(
			(job) =>
				job.status === "pending" ||
				job.status === "running",
		)
		.map((job) => {
			const { outputTarget: _drop, ...restOptions } = job.options;
			// running → pending: a crashed run should resume, not stay stuck at
			// "running" forever. Chunked resume is out of scope for MVP, so we
			// also reset progress to 0 (the re-run starts from frame 0).
			if (job.status === "running") {
				return { ...job, status: "pending", progress: 0, options: restOptions };
			}
			return { ...job, options: restOptions };
		});
}

export async function saveQueueSnapshot({
	jobs,
}: {
	jobs: ExportQueueJob[];
}): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const record: QueueRecord = {
		key: RECORD_KEY,
		jobs: sanitizeForPersistence({ jobs }),
	};
	const db = await openDB();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readwrite");
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.objectStore(STORE_NAME).put(record);
		});
	} finally {
		db.close();
	}
}

export async function loadQueueSnapshot(): Promise<ExportQueueJob[]> {
	if (typeof indexedDB === "undefined") return [];
	const db = await openDB();
	try {
		return await new Promise<ExportQueueJob[]>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readonly");
			const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
			req.onerror = () => reject(req.error);
			req.onsuccess = () => {
				const value = req.result;
				resolve(isQueueRecord(value) ? value.jobs : []);
			};
		});
	} finally {
		db.close();
	}
}

export async function clearQueueSnapshot(): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDB();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readwrite");
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.objectStore(STORE_NAME).delete(RECORD_KEY);
		});
	} finally {
		db.close();
	}
}

/** Test seam: exposed so unit tests can exercise the sanitize step directly. */
export const __internal = { sanitizeForPersistence };
