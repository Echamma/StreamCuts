import { describe, expect, test } from "bun:test";
import type { ExportOptions, ExportResult } from "@/export";
import {
	addJobToQueue,
	clearFinishedJobs,
	isQueueRunnable,
	nextPendingJob,
	patchJob,
	removeJobFromQueue,
	runExportQueue,
	summarizeQueue,
	type ExportQueueJob,
} from "@/export/queue-runner";

const OPTIONS: ExportOptions = { format: "mp4", quality: "high" };

function job({
	id,
	status = "pending",
}: {
	id: string;
	status?: ExportQueueJob["status"];
}): ExportQueueJob {
	return { id, name: id, options: OPTIONS, status, progress: 0 };
}

describe("pure queue transforms", () => {
	test("add / remove / patch", () => {
		let jobs: ExportQueueJob[] = [];
		jobs = addJobToQueue({ jobs, job: job({ id: "a" }) });
		jobs = addJobToQueue({ jobs, job: job({ id: "b" }) });
		expect(jobs.map((j) => j.id)).toEqual(["a", "b"]);

		jobs = patchJob({ jobs, id: "a", patch: { status: "done" } });
		expect(jobs.find((j) => j.id === "a")?.status).toBe("done");

		jobs = removeJobFromQueue({ jobs, id: "b" });
		expect(jobs.map((j) => j.id)).toEqual(["a"]);
	});

	test("nextPendingJob / isQueueRunnable skip finished jobs", () => {
		const jobs = [
			job({ id: "a", status: "done" }),
			job({ id: "b", status: "pending" }),
		];
		expect(nextPendingJob({ jobs })?.id).toBe("b");
		expect(isQueueRunnable({ jobs })).toBe(true);
		expect(
			isQueueRunnable({ jobs: [job({ id: "a", status: "done" })] }),
		).toBe(false);
	});

	test("clearFinishedJobs keeps pending/running only", () => {
		const jobs = [
			job({ id: "a", status: "done" }),
			job({ id: "b", status: "failed" }),
			job({ id: "c", status: "pending" }),
			job({ id: "d", status: "running" }),
		];
		expect(clearFinishedJobs({ jobs }).map((j) => j.id)).toEqual(["c", "d"]);
	});

	test("summarizeQueue counts by status", () => {
		const jobs = [
			job({ id: "a", status: "done" }),
			job({ id: "b", status: "done" }),
			job({ id: "c", status: "failed" }),
			job({ id: "d", status: "pending" }),
		];
		expect(summarizeQueue({ jobs })).toEqual({
			total: 4,
			pending: 1,
			running: 0,
			done: 2,
			failed: 1,
			cancelled: 0,
		});
	});
});

interface Harness {
	deps: Parameters<typeof runExportQueue>[0];
	getJobs: () => ExportQueueJob[];
	downloaded: string[];
}

function makeHarness({
	initial,
	results,
	cancelAfter,
}: {
	initial: ExportQueueJob[];
	results?: Record<string, ExportResult | "throw">;
	cancelAfter?: number;
}): Harness {
	let jobs = initial;
	const downloaded: string[] = [];
	let started = 0;

	return {
		getJobs: () => jobs,
		downloaded,
		deps: {
			getJobs: () => jobs,
			runJob: async ({ job: j }) => {
				const outcome = results?.[j.id] ?? { success: true, buffer: new ArrayBuffer(1) };
				if (outcome === "throw") throw new Error(`boom ${j.id}`);
				return outcome;
			},
			onJobStart: ({ id }) => {
				started += 1;
				jobs = patchJob({ jobs, id, patch: { status: "running" } });
			},
			onJobFinish: ({ id, status, error }) => {
				jobs = patchJob({ jobs, id, patch: { status, error } });
			},
			onJobResult: ({ job: j }) => {
				downloaded.push(j.id);
			},
			isCancelled: () => cancelAfter !== undefined && started >= cancelAfter,
		},
	};
}

describe("runExportQueue", () => {
	test("runs all pending jobs in order and downloads each success", async () => {
		const h = makeHarness({
			initial: [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })],
		});
		await runExportQueue(h.deps);
		expect(h.getJobs().map((j) => j.status)).toEqual(["done", "done", "done"]);
		expect(h.downloaded).toEqual(["a", "b", "c"]);
	});

	test("a failed export marks that job failed and continues", async () => {
		const h = makeHarness({
			initial: [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })],
			results: { b: { success: false, error: "encoder died" } },
		});
		await runExportQueue(h.deps);
		const byId = Object.fromEntries(h.getJobs().map((j) => [j.id, j]));
		expect(byId.a.status).toBe("done");
		expect(byId.b.status).toBe("failed");
		expect(byId.b.error).toBe("encoder died");
		expect(byId.c.status).toBe("done");
		expect(h.downloaded).toEqual(["a", "c"]);
	});

	test("a thrown error is caught as a failed job", async () => {
		const h = makeHarness({
			initial: [job({ id: "a" }), job({ id: "b" })],
			results: { a: "throw" },
		});
		await runExportQueue(h.deps);
		const byId = Object.fromEntries(h.getJobs().map((j) => [j.id, j]));
		expect(byId.a.status).toBe("failed");
		expect(byId.a.error).toBe("boom a");
		expect(byId.b.status).toBe("done");
	});

	test("cancellation marks remaining pending jobs cancelled", async () => {
		// Cancel takes effect after the first job starts.
		const h = makeHarness({
			initial: [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })],
			cancelAfter: 1,
		});
		await runExportQueue(h.deps);
		const byId = Object.fromEntries(h.getJobs().map((j) => [j.id, j]));
		expect(byId.a.status).toBe("done");
		expect(byId.b.status).toBe("cancelled");
		expect(byId.c.status).toBe("cancelled");
		expect(h.downloaded).toEqual(["a"]);
	});
});
