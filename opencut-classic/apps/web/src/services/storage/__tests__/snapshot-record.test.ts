import { describe, expect, test } from "bun:test";
import type {
	ProjectSnapshotRecord,
	ProjectSnapshotSource,
} from "@/services/storage/types";

function makeSnapshot({
	projectId,
	snapshotId,
	savedAt,
	source,
	label = "",
}: {
	projectId: string;
	snapshotId: string;
	savedAt: string;
	source: ProjectSnapshotSource;
	label?: string;
}): ProjectSnapshotRecord {
	return {
		id: `${projectId}/${snapshotId}`,
		projectId,
		snapshotId,
		savedAt,
		source,
		label,
		author: "",
		payload: {
			metadata: {
				id: projectId,
				name: "t",
				duration: 0 as never,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: savedAt,
			},
			scenes: [],
			currentSceneId: "",
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000" },
			},
			version: 1,
		},
	};
}

describe("ProjectSnapshotRecord composite key", () => {
	test("id is projectId/snapshotId so a single store fans across projects", () => {
		const record = makeSnapshot({
			projectId: "proj-1",
			snapshotId: "autosave-abc",
			savedAt: "2026-06-29T10:00:00.000Z",
			source: "autosave",
		});
		expect(record.id).toBe("proj-1/autosave-abc");
	});

	test("two snapshots for the same project share the projectId prefix", () => {
		const a = makeSnapshot({
			projectId: "proj-2",
			snapshotId: "autosave-1",
			savedAt: "2026-06-29T10:00:00.000Z",
			source: "autosave",
		});
		const b = makeSnapshot({
			projectId: "proj-2",
			snapshotId: "manual-1",
			savedAt: "2026-06-29T10:05:00.000Z",
			source: "manual",
			label: "v1",
		});
		expect(a.id.startsWith("proj-2/")).toBe(true);
		expect(b.id.startsWith("proj-2/")).toBe(true);
	});

	test("named version carries a non-empty label; autosave's label is empty", () => {
		const auto = makeSnapshot({
			projectId: "p",
			snapshotId: "a-1",
			savedAt: "2026-06-29T10:00:00.000Z",
			source: "autosave",
		});
		const named = makeSnapshot({
			projectId: "p",
			snapshotId: "m-1",
			savedAt: "2026-06-29T10:05:00.000Z",
			source: "manual",
			label: "tighter cuts",
		});
		expect(auto.label).toBe("");
		expect(named.label).toBe("tighter cuts");
	});

	test("author field is reserved (empty in v1) for the multi-user seam", () => {
		const snap = makeSnapshot({
			projectId: "p",
			snapshotId: "x",
			savedAt: "2026-06-29T10:00:00.000Z",
			source: "autosave",
		});
		expect(snap.author).toBe("");
	});
});

describe("snapshot ordering helpers", () => {
	test("ISO savedAt strings sort lexicographically in date order", () => {
		const a = "2026-06-29T10:00:00.000Z";
		const b = "2026-06-29T10:05:00.000Z";
		const c = "2026-06-29T09:00:00.000Z";
		const sorted = [a, b, c].sort((x, y) => y.localeCompare(x));
		expect(sorted).toEqual([b, a, c]);
	});
});
