import { expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { selectVideoAssetSource } from "@/services/renderer/video-source";

test("preview uses an attached proxy and export retains the master", () => {
	const master = new File(["master"], "master.mp4", { type: "video/mp4" });
	const proxy = new File(["proxy"], "proxy.mp4", { type: "video/mp4" });
	const asset: MediaAsset = {
		id: "video-1",
		name: "master.mp4",
		type: "video",
		size: master.size,
		lastModified: 0,
		file: master,
		proxyFile: proxy,
		hasProxy: true,
		source: { kind: "file" },
	};

	expect(selectVideoAssetSource({ asset, isPreview: true })).toEqual({
		mediaId: "video-1:proxy",
		file: proxy,
	});
	expect(selectVideoAssetSource({ asset, isPreview: false })).toEqual({
		mediaId: "video-1",
		file: master,
	});
});
