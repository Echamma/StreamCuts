import { describe, expect, test } from "bun:test";
import {
	REFRAME_IDENTITY,
	isReframeIdentity,
	readReframeFromParams,
} from "@/rendering/reframe";

describe("REFRAME_IDENTITY", () => {
	test("centers anchor at frame center with no zoom", () => {
		expect(REFRAME_IDENTITY).toEqual({ x: 0.5, y: 0.5, scale: 1 });
	});
});

describe("isReframeIdentity", () => {
	test("true for {0.5, 0.5, 1}", () => {
		expect(isReframeIdentity({ x: 0.5, y: 0.5, scale: 1 })).toBe(true);
	});

	test("false when x is shifted", () => {
		expect(isReframeIdentity({ x: 0.6, y: 0.5, scale: 1 })).toBe(false);
	});

	test("false when y is shifted", () => {
		expect(isReframeIdentity({ x: 0.5, y: 0.4, scale: 1 })).toBe(false);
	});

	test("false when zoomed", () => {
		expect(isReframeIdentity({ x: 0.5, y: 0.5, scale: 1.5 })).toBe(false);
	});
});

describe("readReframeFromParams", () => {
	test("falls back to identity when params are empty", () => {
		expect(readReframeFromParams({ params: {} })).toEqual(REFRAME_IDENTITY);
	});

	test("ignores non-numeric values", () => {
		const reframe = readReframeFromParams({
			params: {
				"reframe.x": "bogus" as unknown as number,
				"reframe.y": null as unknown as number,
				"reframe.scale": undefined as unknown as number,
			},
		});
		expect(reframe).toEqual(REFRAME_IDENTITY);
	});

	test("reads provided numeric values", () => {
		const reframe = readReframeFromParams({
			params: {
				"reframe.x": 0.25,
				"reframe.y": 0.75,
				"reframe.scale": 2,
			},
		});
		expect(reframe).toEqual({ x: 0.25, y: 0.75, scale: 2 });
	});
});

