import { describe, expect, test } from "bun:test";
import type { ExportOptions } from "@/export";
import { __internal } from "@/export/queue-persistence";
import type { ExportQueueJob } from "@/export/queue-runner";

const OPTIONS: ExportOptions = { format: "mp4", quality: "high" };

function job({
	id,
	status = "pending",
	progress = 0,
	options = OPTIONS,
}: {
	id: string;
	status?: ExportQueueJob["status"];
	progress?: number;
	options?: ExportOptions;
}): ExportQueueJob {
	return { id, name: id, options, status, progress };
}

describe("sanitizeForPersistence (DEL-001)", () => {
	test("drops finished jobs (done/failed/cancelled)", () => {
		const jobs = [
			job({ id: "a", status: "pending" }),
			job({ id: "b", status: "done" }),
			job({ id: "c", status: "failed" }),
			job({ id: "d", status: "cancelled" }),
			job({ id: "e", status: "running" }),
		];
		const sanitized = __internal.sanitizeForPersistence({ jobs });
		expect(sanitized.map((j) => j.id).sort()).toEqual(["a", "e"]);
	});

	test("demotes running to pending and resets progress", () => {
		const jobs = [job({ id: "a", status: "running", progress: 0.42 })];
		const sanitized = __internal.sanitizeForPersistence({ jobs });
		expect(sanitized[0].status).toBe("pending");
		expect(sanitized[0].progress).toBe(0);
	});

	test("keeps pending progress untouched (defensive)", () => {
		const jobs = [job({ id: "a", status: "pending", progress: 0.3 })];
		const sanitized = __internal.sanitizeForPersistence({ jobs });
		expect(sanitized[0].status).toBe("pending");
		expect(sanitized[0].progress).toBe(0.3);
	});

	test("strips outputTarget from options (FileSystemWritableFileStream is not serializable)", () => {
		const withOutput = job({
			id: "a",
			status: "pending",
			options: {
				format: "mp4",
				quality: "high",
				outputTarget: {
					mode: "buffer",
				},
			},
		});
		const sanitized = __internal.sanitizeForPersistence({ jobs: [withOutput] });
		expect("outputTarget" in sanitized[0].options).toBe(false);
	});

	test("preserves format/quality/fps/scene-target/canvasSizeOverride", () => {
		const options: ExportOptions = {
			format: "webm-av1",
			quality: "medium",
			fps: { numerator: 30, denominator: 1 },
			includeAudio: false,
			sceneTarget: { mode: "specific", sceneId: "s-1" },
			canvasSizeOverride: { width: 1080, height: 1080 },
		};
		const sanitized = __internal.sanitizeForPersistence({
			jobs: [job({ id: "a", options })],
		});
		expect(sanitized[0].options).toEqual(options);
	});

	test("empty input → empty output", () => {
		expect(__internal.sanitizeForPersistence({ jobs: [] })).toEqual([]);
	});
});
