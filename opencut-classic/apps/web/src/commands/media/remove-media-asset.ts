import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import {
	getMediaAssetSource,
	isSubclipAsset,
} from "@/media/asset-source";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { hasMediaId } from "@/timeline/element-utils";
import { getOrderedTimelineTracks } from "@/timeline/scene-tracks-view";
import type { SceneTracks } from "@/timeline";

export class RemoveMediaAssetCommand extends Command {
	private savedAssets: MediaAsset[] | null = null;
	private savedTracks: SceneTracks | null = null;
	private removedAsset: MediaAsset | null = null;

	constructor({
		projectId,
		assetId,
	}: {
		projectId: string;
		assetId: string;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
	}

	private projectId: string;
	private assetId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();

		this.savedAssets = [...assets];
		this.savedTracks = editor.scenes.getActiveScene().tracks;

		this.removedAsset =
			assets.find((media) => media.id === this.assetId) ?? null;

		if (!this.removedAsset) {
			console.error("Media asset not found:", this.assetId);
			return;
		}

		const dependentSubclips = isSubclipAsset({ asset: this.removedAsset })
			? []
			: assets.filter((asset) => {
					const source = getMediaAssetSource({ asset });
					return (
						source.kind === "subclip" &&
						source.rootSourceAssetId === this.removedAsset?.id
					);
				});
		if (dependentSubclips.length > 0) {
			toast.error("Delete blocked", {
				description:
					dependentSubclips.length === 1
						? "This source media has 1 saved subclip in Assets. Delete that subclip first."
						: `This source media has ${dependentSubclips.length} saved subclips in Assets. Delete those subclips first.`,
			});
			return;
		}

		const isSharedUrl = !!this.removedAsset.url &&
			assets.some(
				(asset) => asset.id !== this.assetId && asset.url === this.removedAsset?.url,
			);
		const isSharedThumbnail = !!this.removedAsset.thumbnailUrl &&
			assets.some(
				(asset) =>
					asset.id !== this.assetId &&
					asset.thumbnailUrl === this.removedAsset?.thumbnailUrl,
			);

		if (this.removedAsset.url && !isSharedUrl) {
			URL.revokeObjectURL(this.removedAsset.url);
		}
		if (this.removedAsset.thumbnailUrl && !isSharedThumbnail) {
			URL.revokeObjectURL(this.removedAsset.thumbnailUrl);
		}

		videoCache.clearVideo({ mediaId: this.assetId });
		if (getMediaAssetSource({ asset: this.removedAsset }).kind === "file") {
			waveformCache.clearSource({
				sourceKey: buildWaveformSourceKey({
					kind: "media",
					id: this.assetId,
				}),
			});
		}

		editor.media.setAssets({
			assets: assets.filter((media) => media.id !== this.assetId),
		});

		const elementsToRemove: Array<{ trackId: string; elementId: string }> = [];

		for (const track of getOrderedTimelineTracks({ tracks: this.savedTracks })) {
			for (const element of track.elements) {
				if (hasMediaId(element) && element.mediaId === this.assetId) {
					elementsToRemove.push({ trackId: track.id, elementId: element.id });
				}
			}
		}

		if (elementsToRemove.length > 0) {
			editor.timeline.deleteElements({ elements: elementsToRemove });
		}

		storageService
			.deleteMediaAsset({ projectId: this.projectId, id: this.assetId })
			.catch((error) => {
				console.error("Failed to delete media item:", error);
			});
	}

	undo(): void {
		const editor = EditorCore.getInstance();

		if (this.savedAssets && this.removedAsset) {
			const restoredAsset: MediaAsset = {
				...this.removedAsset,
				url: URL.createObjectURL(this.removedAsset.file),
			};

			editor.media.setAssets({
				assets: this.savedAssets.map((a) =>
					a.id === this.assetId ? restoredAsset : a,
				),
			});

			storageService
				.saveMediaAsset({
					projectId: this.projectId,
					mediaAsset: restoredAsset,
				})
				.catch((error) => {
					console.error("Failed to restore media item on undo:", error);
				});
		}

		if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}
	}
}
