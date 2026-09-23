import type { MediaAsset } from "@/media/types";

export type DerivedAssetKind = "waveform" | "proxy";

export function derivedAssetTaskKey({
	assetId,
	kind,
}: {
	assetId: string;
	kind: DerivedAssetKind;
}): string {
	return `${assetId}:${kind}`;
}

export function shouldQueueProxy({
	asset,
	autoProxies,
}: {
	asset: MediaAsset;
	autoProxies: boolean;
}): boolean {
	return (
		autoProxies && asset.type === "video" && !asset.hasProxy && !asset.ephemeral
	);
}
