import { afterAll, expect, mock, test } from "bun:test";

// Model CanvasSink's documented ring-buffer behavior, including pixel mutation.
// The production cache chooses ownership through the real constructor options.
class FakeSink {
	private pool: { width: number; height: number; pixel: number }[];
	private index = 0;
	// Match the third-party CanvasSink constructor signature.
	// eslint-disable-next-line opencut/prefer-object-params
	constructor(_track: unknown, options: { poolSize?: number }) {
		this.pool = Array.from({ length: options.poolSize ?? 0 }, () => ({
			width: 16,
			height: 16,
			pixel: -1,
		}));
	}
	async *canvases(time: number) {
		for (let frame = Math.floor(time * 90); frame < 900; frame++) {
			const canvas = this.pool.length
				? this.pool[this.index++ % this.pool.length]
				: { width: 16, height: 16, pixel: -1 };
			canvas.pixel = frame;
			yield { canvas, timestamp: frame / 90, duration: 1 / 90 };
		}
	}
}
const originalMediabunny = await import("mediabunny");
mock.module("mediabunny", () => ({
	...originalMediabunny,
	ALL_FORMATS: [],
	BlobSource: class {},
	CanvasSink: FakeSink,
	Input: class {
		async getPrimaryVideoTrack() {
			return { canDecode: async () => true };
		}
		dispose() {}
	},
}));
afterAll(() => mock.module("mediabunny", () => originalMediabunny));
const { VideoCache } = await import("../service");

test("held frames survive same-asset seeks and more than one pool rotation", async () => {
	const cache = new VideoCache();
	const file = new File([], "counter.mp4");
	const frames = [];
	try {
		for (const frameNumber of [0, 3, 6, 60, 9, 30, 90, 12]) {
			const frame = await cache.getFrameAt({
				mediaId: "shared",
				file,
				time: frameNumber / 90 + 0.00001,
				exact: true,
			});
			expect(frame).not.toBeNull();
			frames.push({ frame: frame!, frameNumber });
		}
		for (const { frame, frameNumber } of frames) {
			expect(frame.canvas).toHaveProperty("pixel", frameNumber);
		}
	} finally {
		cache.clearAll();
	}
});

test("preview prefetch cannot overwrite a frame retained by export", async () => {
	const cache = new VideoCache();
	const file = new File([], "counter.mp4");
	try {
		const held = await cache.getFrameAt({
			mediaId: "shared",
			file,
			time: 0,
			exact: true,
		});
		for (const time of [0.2, 0.4, 0.6]) {
			await cache.getFrameAt({ mediaId: "shared", file, time });
		}
		expect(held!.canvas).toHaveProperty("pixel", 0);
	} finally {
		cache.clearAll();
	}
});
