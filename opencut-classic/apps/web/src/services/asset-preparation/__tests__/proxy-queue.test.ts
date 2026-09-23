import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import {
	derivedAssetTaskKey,
	shouldQueueProxy,
} from "@/services/asset-preparation/queue-policy";

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "video-1",
		name: "clip.mp4",
		type: "video",
		size: 4,
		lastModified: 0,
		file: new File(["clip"], "clip.mp4", { type: "video/mp4" }),
		source: { kind: "file" },
		...overrides,
	};
}

describe("proxy queue gating", () => {
	test("off by default, even for an unproxied video", () => {
		expect(shouldQueueProxy({ asset: asset(), autoProxies: false })).toBe(
			false,
		);
	});

	test("queues only persistent video without an existing proxy", () => {
		expect(shouldQueueProxy({ asset: asset(), autoProxies: true })).toBe(true);
		expect(
			shouldQueueProxy({ asset: asset({ type: "audio" }), autoProxies: true }),
		).toBe(false);
		expect(
			shouldQueueProxy({ asset: asset({ type: "image" }), autoProxies: true }),
		).toBe(false);
		expect(
			shouldQueueProxy({ asset: asset({ hasProxy: true }), autoProxies: true }),
		).toBe(false);
		expect(
			shouldQueueProxy({
				asset: asset({ ephemeral: true }),
				autoProxies: true,
			}),
		).toBe(false);
	});

	test("waveform and proxy jobs for one asset have different dedupe keys", () => {
		expect(
			derivedAssetTaskKey({ assetId: "video-1", kind: "waveform" }),
		).not.toBe(derivedAssetTaskKey({ assetId: "video-1", kind: "proxy" }));
	});
});
