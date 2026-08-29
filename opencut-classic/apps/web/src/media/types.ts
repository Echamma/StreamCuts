import type {
	MediaAssetData,
	MediaAssetSource,
	MediaType,
} from "@/services/storage/types";

export type { MediaAssetSource, MediaType } from "@/services/storage/types";

export interface MediaAsset extends MediaAssetData {
	file: File;
	url?: string;
	source: MediaAssetSource;
	/**
	 * All-intra editing proxy for `file`, when one has been generated (MED-005).
	 * Preview decodes this instead of the master — the master may be long-GOP,
	 * high-bitrate media that no browser can scrub — while export always uses
	 * the master, so renders stay full quality.
	 */
	proxyFile?: File;
}
