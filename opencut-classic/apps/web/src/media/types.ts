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
}
