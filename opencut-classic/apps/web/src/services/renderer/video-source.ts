import type { MediaAsset } from "@/media/types";
import { mediaProxyStorageKey } from "@/services/storage/types";

/** Preview uses the editing proxy; export always decodes the master. */
export function selectVideoAssetSource({
	asset,
	isPreview,
}: {
	asset: MediaAsset;
	isPreview: boolean;
}): { mediaId: string; file: File } {
	const proxy = isPreview ? asset.proxyFile : undefined;
	return {
		mediaId: proxy ? mediaProxyStorageKey(asset.id) : asset.id,
		file: proxy ?? asset.file,
	};
}
