import {
	buildElementFromMedia,
	type CreateTimelineElement,
} from "@/timeline";
import type {
	MediaAsset,
	MediaAssetSource,
	MediaType,
} from "@/media/types";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import {
	mediaTime,
	mediaTimeFromSeconds,
	type MediaTime,
	roundMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export const FILE_MEDIA_ASSET_SOURCE: MediaAssetSource = {
	kind: "file",
};

export function getMediaAssetSource({
	asset,
}: {
	asset: Pick<MediaAsset, "source"> | { source?: MediaAssetSource };
}): MediaAssetSource {
	return asset.source ?? FILE_MEDIA_ASSET_SOURCE;
}

export function isSubclipAsset({
	asset,
}: {
	asset: Pick<MediaAsset, "source"> | { source?: MediaAssetSource };
}): boolean {
	return getMediaAssetSource({ asset }).kind === "subclip";
}

export function getRootSourceAssetId({
	asset,
}: {
	asset: Pick<MediaAsset, "id" | "source"> | { id: string; source?: MediaAssetSource };
}): string {
	const source = getMediaAssetSource({ asset });
	return source.kind === "subclip" ? source.rootSourceAssetId : asset.id;
}

export function getAssetSourceStartTime({
	asset,
}: {
	asset: Pick<MediaAsset, "source"> | { source?: MediaAssetSource };
}): MediaTime {
	const source = getMediaAssetSource({ asset });
	return source.kind === "subclip"
		? roundMediaTime({ time: source.sourceStartTime })
		: ZERO_MEDIA_TIME;
}

export function findRootSourceAsset({
	asset,
	assets,
}: {
	asset: MediaAsset;
	assets: MediaAsset[];
}): MediaAsset | null {
	const rootSourceAssetId = getRootSourceAssetId({ asset });
	return assets.find((candidate) => candidate.id === rootSourceAssetId) ?? null;
}

export function getWaveformSourceKeyForAsset({
	asset,
}: {
	asset: Pick<MediaAsset, "id" | "source">;
}): string {
	return buildWaveformSourceKey({
		kind: "media",
		id: getRootSourceAssetId({ asset }),
	});
}

export function buildElementFromAsset({
	asset,
	startTime,
	buffer,
}: {
	asset: MediaAsset;
	startTime: MediaTime;
	buffer?: AudioBuffer;
}): CreateTimelineElement {
	const source = getMediaAssetSource({ asset });
	const defaultDuration =
		asset.duration != null
			? mediaTimeFromSeconds({ seconds: asset.duration })
			: DEFAULT_NEW_ELEMENT_DURATION;

	if (source.kind !== "subclip") {
		return buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration: defaultDuration,
			startTime,
			buffer,
		});
	}

	const element = buildElementFromMedia({
		mediaId: asset.id,
		mediaType: asset.type,
		name: asset.name,
		duration: mediaTime({ ticks: source.timelineDuration }),
		startTime,
		buffer,
	});

	if (element.type === "video") {
		return {
			...element,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			sourceDuration: mediaTime({ ticks: source.sourceDuration }),
			retime: source.retime,
			isSourceAudioEnabled: source.includeAudio !== false,
		};
	}

	if (element.type === "audio" && element.sourceType === "upload") {
		return {
			...element,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			sourceDuration: mediaTime({ ticks: source.sourceDuration }),
			retime: source.retime,
		};
	}

	return element;
}

export function estimateSubclipAssetSize({
	rootAsset,
	sourceDuration,
}: {
	rootAsset: Pick<MediaAsset, "size" | "duration">;
	sourceDuration: MediaTime;
}): number {
	if (!rootAsset.duration || rootAsset.duration <= 0) {
		return rootAsset.size;
	}

	const ratio = Math.max(
		0,
		Math.min(
			1,
			(sourceDuration as number) / (rootAsset.duration * TICKS_PER_SECOND),
		),
	);
	return Math.max(1, Math.round(rootAsset.size * ratio));
}

export function isAudioMediaType({
	type,
}: {
	type: MediaType;
}): boolean {
	return type === "audio";
}
