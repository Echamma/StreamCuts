import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { normalizeAttributes } from "@/media/metadata";
import type { ClipAttributes } from "@/services/storage/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/commands";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			this.editor.project.ratchetFpsForImportedMedia({
				importedAssets: [newAsset],
			});
			return newAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand({
						projectId,
						assetId: uniqueIds[0],
					})
				: new BatchCommand(
						uniqueIds.map((id) =>
							new RemoveMediaAssetCommand({
								projectId,
								assetId: id,
							}),
						),
					);

		this.editor.command.execute({ command });
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;
			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		videoCache.clearAll();
		waveformCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	getAssetsForScene({ sceneId }: { sceneId: string | null }): MediaAsset[] {
		if (!sceneId) return this.assets;
		return this.assets.filter(
			(a) => a.sceneId === sceneId || a.sceneId == null,
		);
	}

	async addMediaAssetToScene({
		projectId,
		asset,
		sceneId,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
		sceneId: string;
	}): Promise<MediaAsset | null> {
		return this.addMediaAsset({
			projectId,
			asset: { ...asset, sceneId },
		});
	}

	async promoteAssetToProjectWide({
		projectId,
		assetId,
	}: {
		projectId: string;
		assetId: string;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset) return;

		const updated = { ...asset, sceneId: undefined };
		this.assets = this.assets.map((a) => (a.id === assetId ? updated : a));
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: updated });
		} catch (error) {
			console.error("Failed to persist asset promotion:", error);
			this.assets = this.assets.map((a) => (a.id === assetId ? asset : a));
			this.notify();
		}
	}

	async copyAssetToScene({
		projectId,
		assetId,
		targetSceneId,
	}: {
		projectId: string;
		assetId: string;
		targetSceneId: string;
	}): Promise<MediaAsset | null> {
		const source = this.assets.find((a) => a.id === assetId);
		if (!source) return null;

		return this.addMediaAsset({
			projectId,
			asset: { ...source, sceneId: targetSceneId },
		});
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	async moveAssetToFolder({
		projectId,
		assetId,
		folderId,
	}: {
		projectId: string;
		assetId: string;
		folderId: string | null;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset) return;

		const updated = { ...asset, folderId };
		this.assets = this.assets.map((a) => (a.id === assetId ? updated : a));
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: updated });
		} catch (error) {
			console.error("Failed to persist asset folder move:", error);
			this.assets = this.assets.map((a) => (a.id === assetId ? asset : a));
			this.notify();
		}
	}

	/**
	 * Set an asset's user attributes (tags / notes / rating, MED-003). The input
	 * is normalised: an all-empty set clears the field, so a cleared editor
	 * leaves the asset identical to one that never had attributes.
	 */
	async updateAssetAttributes({
		projectId,
		assetId,
		attributes,
	}: {
		projectId: string;
		assetId: string;
		attributes: ClipAttributes;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset) return;

		const normalized = normalizeAttributes({ attributes });
		const updated = { ...asset, attributes: normalized };
		this.assets = this.assets.map((a) => (a.id === assetId ? updated : a));
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: updated });
		} catch (error) {
			console.error("Failed to persist asset attributes:", error);
			this.assets = this.assets.map((a) => (a.id === assetId ? asset : a));
			this.notify();
		}
	}

	/**
	 * Attach an all-intra editing proxy to an asset (MED-005). Preview switches
	 * to it immediately — the scene builder prefers `proxyFile` — while export
	 * keeps using the master, so this only ever changes how smoothly the clip
	 * scrubs, never the rendered result.
	 */
	async attachAssetProxy({
		projectId,
		assetId,
		proxyFile,
	}: {
		projectId: string;
		assetId: string;
		proxyFile: File;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset) return;

		const updated = { ...asset, proxyFile, hasProxy: true };
		this.assets = this.assets.map((a) => (a.id === assetId ? updated : a));
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: updated });
		} catch (error) {
			console.error("Failed to persist asset proxy:", error);
			this.assets = this.assets.map((a) => (a.id === assetId ? asset : a));
			this.notify();
			throw error;
		}
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
