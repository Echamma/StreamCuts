import type { ExportOptions, ExportResult } from "@/export";

/** Lifecycle of a single queued export (DEL-001). */
export type ExportJobStatus =
	| "pending"
	| "running"
	| "done"
	| "failed"
	| "cancelled";

export interface ExportQueueJob {
	id: string;
	/** Filename base (no extension) — the format decides the extension. */
	name: string;
	/** The per-job export settings. `outputTarget` is ignored here: the queue
	 * always renders to a buffer and auto-downloads so it can run unattended
	 * without a save dialog per job. */
	options: ExportOptions;
	status: ExportJobStatus;
	/** 0..1 while running. */
	progress: number;
	error?: string;
}

// ── Pure queue transforms (no side effects, unit-tested) ─────────────────────

export function addJobToQueue({
	jobs,
	job,
}: {
	jobs: ExportQueueJob[];
	job: ExportQueueJob;
}): ExportQueueJob[] {
	return [...jobs, job];
}

export function removeJobFromQueue({
	jobs,
	id,
}: {
	jobs: ExportQueueJob[];
	id: string;
}): ExportQueueJob[] {
	return jobs.filter((job) => job.id !== id);
}

export function patchJob({
	jobs,
	id,
	patch,
}: {
	jobs: ExportQueueJob[];
	id: string;
	patch: Partial<Omit<ExportQueueJob, "id">>;
}): ExportQueueJob[] {
	return jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
}

/** Clear only the jobs that have finished (done/failed/cancelled), keeping any
 * that are still pending or running. */
export function clearFinishedJobs({
	jobs,
}: {
	jobs: ExportQueueJob[];
}): ExportQueueJob[] {
	return jobs.filter(
		(job) => job.status === "pending" || job.status === "running",
	);
}

export function nextPendingJob({
	jobs,
}: {
	jobs: ExportQueueJob[];
}): ExportQueueJob | null {
	return jobs.find((job) => job.status === "pending") ?? null;
}

export function isQueueRunnable({ jobs }: { jobs: ExportQueueJob[] }): boolean {
	return jobs.some((job) => job.status === "pending");
}

export interface ExportQueueSummary {
	total: number;
	pending: number;
	running: number;
	done: number;
	failed: number;
	cancelled: number;
}

export function summarizeQueue({
	jobs,
}: {
	jobs: ExportQueueJob[];
}): ExportQueueSummary {
	const summary: ExportQueueSummary = {
		total: jobs.length,
		pending: 0,
		running: 0,
		done: 0,
		failed: 0,
		cancelled: 0,
	};
	for (const job of jobs) {
		summary[job.status] += 1;
	}
	return summary;
}

// ── Sequential executor ──────────────────────────────────────────────────────

export interface RunExportQueueDeps {
	/** Live snapshot of the current jobs (re-read each iteration so newly added
	 * jobs are picked up and status updates are observed). */
	getJobs: () => ExportQueueJob[];
	/** Run one job to completion. Wraps `editor.project.export` in the app; a
	 * plain async fn in tests. */
	runJob: (params: { job: ExportQueueJob }) => Promise<ExportResult>;
	onJobStart: (params: { id: string }) => void;
	onJobFinish: (params: {
		id: string;
		status: ExportJobStatus;
		error?: string;
	}) => void;
	/** Deliver a successful render (download in the app). */
	onJobResult: (params: { job: ExportQueueJob; result: ExportResult }) => void;
	/** Checked before each job; when true the remaining pending jobs are marked
	 * cancelled and the run stops. */
	isCancelled: () => boolean;
}

/** Run every pending job in order. Each job is isolated: a failure or a thrown
 * error marks that job failed and the queue continues with the next one. */
export async function runExportQueue({
	getJobs,
	runJob,
	onJobStart,
	onJobFinish,
	onJobResult,
	isCancelled,
}: RunExportQueueDeps): Promise<void> {
	for (;;) {
		if (isCancelled()) {
			for (const job of getJobs()) {
				if (job.status === "pending") {
					onJobFinish({ id: job.id, status: "cancelled" });
				}
			}
			return;
		}

		const job = nextPendingJob({ jobs: getJobs() });
		if (!job) return;

		onJobStart({ id: job.id });
		try {
			const result = await runJob({ job });
			if (result.cancelled) {
				onJobFinish({ id: job.id, status: "cancelled" });
				continue;
			}
			if (result.success) {
				onJobResult({ job, result });
				onJobFinish({ id: job.id, status: "done" });
			} else {
				onJobFinish({
					id: job.id,
					status: "failed",
					error: result.error ?? "Export failed",
				});
			}
		} catch (error) {
			onJobFinish({
				id: job.id,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
