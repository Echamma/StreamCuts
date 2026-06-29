import { describe, expect, test } from "bun:test";
import {
	canvasSizeMatchesTargetAspect,
	getTargetAspectDefaultSize,
	resolveExportCanvasSize,
	type TProject,
} from "@/project/types";
import type { FrameRate } from "opencut-wasm";

const FPS_30: FrameRate = { numerator: 30, denominator: 1 };

function makeProject(overrides: Partial<TProject["settings"]>): TProject {
	return {
		metadata: {
			id: "p1",
			name: "test",
			duration: 0 as never,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		scenes: [],
		currentSceneId: "s1",
		version: 1,
		settings: {
			fps: FPS_30,
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000" },
			...overrides,
		},
	};
}

describe("canvasSizeMatchesTargetAspect", () => {
	test("1920x1080 matches 16:9", () => {
		expect(
			canvasSizeMatchesTargetAspect({
				canvasSize: { width: 1920, height: 1080 },
				targetAspect: "16:9",
			}),
		).toBe(true);
	});

	test("720x1280 matches 9:16", () => {
		expect(
			canvasSizeMatchesTargetAspect({
				canvasSize: { width: 720, height: 1280 },
				targetAspect: "9:16",
			}),
		).toBe(true);
	});

	test("1920x1080 does not match 9:16", () => {
		expect(
			canvasSizeMatchesTargetAspect({
				canvasSize: { width: 1920, height: 1080 },
				targetAspect: "9:16",
			}),
		).toBe(false);
	});

	test("zero-width canvas does not match", () => {
		expect(
			canvasSizeMatchesTargetAspect({
				canvasSize: { width: 0, height: 1080 },
				targetAspect: "16:9",
			}),
		).toBe(false);
	});
});

describe("getTargetAspectDefaultSize", () => {
	test("9:16 maps to 1080x1920", () => {
		expect(getTargetAspectDefaultSize({ targetAspect: "9:16" })).toEqual({
			width: 1080,
			height: 1920,
		});
	});

	test("1:1 maps to 1080x1080", () => {
		expect(getTargetAspectDefaultSize({ targetAspect: "1:1" })).toEqual({
			width: 1080,
			height: 1080,
		});
	});

	test("4:5 maps to 1080x1350", () => {
		expect(getTargetAspectDefaultSize({ targetAspect: "4:5" })).toEqual({
			width: 1080,
			height: 1350,
		});
	});
});

describe("resolveExportCanvasSize", () => {
	test("override beats everything", () => {
		const project = makeProject({ targetAspect: "9:16" });
		expect(
			resolveExportCanvasSize({
				project,
				canvasSizeOverride: { width: 100, height: 200 },
			}),
		).toEqual({ width: 100, height: 200 });
	});

	test("falls back to project canvasSize when no targetAspect", () => {
		const project = makeProject({});
		expect(resolveExportCanvasSize({ project })).toEqual({
			width: 1920,
			height: 1080,
		});
	});

	test("keeps project canvasSize when it already matches targetAspect", () => {
		const project = makeProject({
			canvasSize: { width: 720, height: 1280 },
			targetAspect: "9:16",
		});
		expect(resolveExportCanvasSize({ project })).toEqual({
			width: 720,
			height: 1280,
		});
	});

	test("derives default size from targetAspect when project canvasSize mismatches", () => {
		const project = makeProject({
			canvasSize: { width: 1920, height: 1080 },
			targetAspect: "9:16",
		});
		expect(resolveExportCanvasSize({ project })).toEqual({
			width: 1080,
			height: 1920,
		});
	});
});
