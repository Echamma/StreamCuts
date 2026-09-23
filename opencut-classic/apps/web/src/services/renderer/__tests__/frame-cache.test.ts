import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const upload = mock(() => {});
mock.module("opencut-wasm", () => ({
	getCompositorCanvas: () => ({}),
	getLastFrameProfile: () => [],
	initCompositor: () => {},
	releaseTexture: () => {},
	renderFrame: () => {},
	resizeCompositor: () => {},
	uploadTexture: upload,
}));

const { wasmCompositor } = await import("../compositor/wasm-compositor");
const originalCanvas = globalThis.OffscreenCanvas;
class FakeCanvas {
	width = 16;
	height = 16;
}

beforeEach(() => {
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		value: FakeCanvas,
		configurable: true,
		writable: true,
	});
});

afterEach(() => {
	wasmCompositor.syncTextures([]);
	upload.mockClear();
	globalThis.OffscreenCanvas = originalCanvas;
});

describe("decoded-frame texture cache", () => {
	test("uploads recycled canvas slots when frame time changes", () => {
		const pool = Array.from({ length: 3 }, () => new OffscreenCanvas(16, 16));
		for (const frame of [0, 3, 6, 9]) {
			wasmCompositor.syncTextures([
				{
					kind: "external",
					id: "video",
					source: pool[frame % 3],
					sourceTimestamp: frame / 90,
					width: 16,
					height: 16,
				},
			]);
		}
		expect(upload).toHaveBeenCalledTimes(4);
	});

	test("retains cache hits for paused video and static images", () => {
		const source = new OffscreenCanvas(16, 16);
		for (let i = 0; i < 3; i++) {
			wasmCompositor.syncTextures([
				{
					kind: "external",
					id: "video",
					source,
					sourceTimestamp: 0,
					width: 16,
					height: 16,
				},
				{ kind: "external", id: "image", source, width: 16, height: 16 },
			]);
		}
		expect(upload).toHaveBeenCalledTimes(2);
	});

	test("uploads a different source even at the same timestamp", () => {
		for (let i = 0; i < 2; i++) {
			wasmCompositor.syncTextures([
				{
					kind: "external",
					id: "video",
					source: new OffscreenCanvas(16, 16),
					sourceTimestamp: 0,
					width: 16,
					height: 16,
				},
			]);
		}
		expect(upload).toHaveBeenCalledTimes(2);
	});
});
