import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { getWaveformSourceKeyForAsset } from "@/media/asset-source";
import { waveformCache } from "@/services/waveform-cache/service";
import { requestProxy, transcodeOutputUrl } from "@/services/transcode/api";
import { toast } from "sonner";
import {
	derivedAssetTaskKey,
	shouldQueueProxy,
	type DerivedAssetKind,
} from "./queue-policy";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { DerivedAssetKind } from "./queue-policy";

export interface DerivedAssetState {
	kind: DerivedAssetKind;
	assetId: string;
	status: "pending" | "ready" | "error";
	error?: string;
}

export interface DerivedAssetManifest {
	readonly byAssetId: ReadonlyMap<string, readonly DerivedAssetState[]>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Eagerly pre-warms derived artifact caches (waveforms, thumbnails, …) so
 * that the first render of a timeline clip finds the data already computed.
 *
 * Work is serialized through a FIFO queue to avoid simultaneous heavy decodes
 * that would compete with playback.  Assets already cached by a prior session
 * or by an explicit component-level fetch are detected via `waveformCache`'s
 * internal promise map and skipped at zero cost.
 */
export class AssetPreparationService {
	private readonly queued = new Set<string>();
	private readonly taskQueue: Array<() => Promise<void>> = [];
	private isRunning = false;
	private disposed = false;

	private readonly byAssetId = new Map<string, DerivedAssetState[]>();
	private manifest: DerivedAssetManifest = { byAssetId: this.byAssetId };
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribers: Array<() => void> = [];

	constructor(private readonly editor: EditorCore) {
		this.unsubscribers.push(
			this.editor.media.subscribe(this.handleMediaChange),
			this.editor.project.subscribe(this.handleMediaChange),
		);
		this.handleMediaChange();
	}

	dispose(): void {
		this.disposed = true;
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers.length = 0;
	}

	getManifest(): DerivedAssetManifest {
		return this.manifest;
	}

	subscribe(onChange: () => void): () => void {
		this.listeners.add(onChange);
		return () => {
			this.listeners.delete(onChange);
		};
	}

	/** Queue every video without a proxy, even when automatic proxies are off. */
	generateProxiesForAllMedia(): number {
		let queued = 0;
		for (const asset of this.editor.media.getAssets()) {
			if (this.queueProxy({ asset, retryOnError: true })) queued++;
		}
		return queued;
	}

	generateProxyForAsset({
		assetId,
		force = false,
	}: {
		assetId: string;
		force?: boolean;
	}): boolean {
		const asset = this.editor.media
			.getAssets()
			.find((item) => item.id === assetId);
		return asset
			? this.queueProxy({ asset, force, retryOnError: true })
			: false;
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private handleMediaChange = (): void => {
		const assets = this.editor.media.getAssets();
		const autoProxies =
			this.editor.project.getActiveOrNull()?.settings.autoProxies === true;
		for (const asset of assets) {
			if (this.needsWaveform(asset)) {
				const key = derivedAssetTaskKey({
					assetId: asset.id,
					kind: "waveform",
				});
				if (!this.queued.has(key)) {
					this.queued.add(key);
					this.enqueue(() => this.prepareWaveform(asset));
				}
			}
			if (shouldQueueProxy({ asset, autoProxies })) {
				this.queueProxy({ asset });
			}
		}
	};

	private queueProxy({
		asset,
		force = false,
		retryOnError = false,
	}: {
		asset: MediaAsset;
		force?: boolean;
		retryOnError?: boolean;
	}): boolean {
		const projectId = this.editor.project.getActiveOrNull()?.metadata.id;
		if (
			!projectId ||
			asset.type !== "video" ||
			asset.ephemeral ||
			(!force && asset.hasProxy)
		)
			return false;
		const key = derivedAssetTaskKey({ assetId: asset.id, kind: "proxy" });
		if (this.queued.has(key)) return false;
		if (
			!retryOnError &&
			this.byAssetId
				.get(asset.id)
				?.some((state) => state.kind === "proxy" && state.status === "error")
		)
			return false;
		this.queued.add(key);
		this.setAssetState({ assetId: asset.id, kind: "proxy", status: "pending" });
		this.enqueue(async () => {
			try {
				await this.prepareProxy({ assetId: asset.id, projectId, force });
			} finally {
				this.queued.delete(key);
			}
		});
		return true;
	}

	private needsWaveform(asset: MediaAsset): boolean {
		if (asset.type === "audio") return true;
		if (asset.type === "video" && asset.hasAudio !== false) return true;
		return false;
	}

	private enqueue(task: () => Promise<void>): void {
		this.taskQueue.push(task);
		this.runQueue();
	}

	private runQueue(): void {
		if (this.isRunning || this.disposed) return;
		const task = this.taskQueue.shift();
		if (!task) return;

		this.isRunning = true;
		task()
			.catch(() => {
				// Each preparation task records its own error state.
			})
			.finally(() => {
				this.isRunning = false;
				// Yield to the event loop between items so decode work doesn't
				// starve playback or UI frames.
				if (this.taskQueue.length > 0 && !this.disposed) {
					setTimeout(() => this.runQueue(), 0);
				}
			});
	}

	private async prepareWaveform(asset: MediaAsset): Promise<void> {
		const sourceKey = getWaveformSourceKeyForAsset({ asset });

		this.setAssetState({
			assetId: asset.id,
			kind: "waveform",
			status: "pending",
		});

		try {
			await waveformCache.getSourceSummary({
				sourceKey,
				sourceFile: asset.file,
			});

			this.setAssetState({
				assetId: asset.id,
				kind: "waveform",
				status: "ready",
			});
		} catch (error) {
			this.setAssetState({
				assetId: asset.id,
				kind: "waveform",
				status: "error",
				error: String(error),
			});
		}
	}

	private async prepareProxy({
		assetId,
		projectId,
		force,
	}: {
		assetId: string;
		projectId: string;
		force: boolean;
	}): Promise<void> {
		if (
			this.disposed ||
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId
		)
			return;
		const asset = this.editor.media
			.getAssets()
			.find((item) => item.id === assetId);
		if (!asset || (asset.hasProxy && !force)) return;
		const toastId = toast.loading(`Building editing proxy for ${asset.name}…`);
		try {
			const result = await requestProxy({ file: asset.file });
			const response = await fetch(
				transcodeOutputUrl({ fileName: result.fileName }),
			);
			if (!response.ok)
				throw new Error(`Could not download the proxy (${response.status}).`);
			const blob = await response.blob();
			if (
				this.disposed ||
				this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				!this.editor.media.getAssets().some((item) => item.id === assetId)
			) {
				toast.dismiss(toastId);
				return;
			}
			const proxyFile = new File([blob], `${asset.name}.proxy.mp4`, {
				type: "video/mp4",
			});
			await this.editor.media.attachAssetProxy({
				projectId,
				assetId,
				proxyFile,
			});
			this.setAssetState({ assetId, kind: "proxy", status: "ready" });
			toast.success(`Editing proxy ready for ${asset.name}.`, { id: toastId });
		} catch (error) {
			this.setAssetState({
				assetId,
				kind: "proxy",
				status: "error",
				error: String(error),
			});
			toast.error(
				error instanceof Error ? error.message : "Proxy generation failed.",
				{ id: toastId },
			);
		}
	}

	private setAssetState({
		assetId,
		kind,
		status,
		error,
	}: {
		assetId: string;
		kind: DerivedAssetKind;
		status: "pending" | "ready" | "error";
		error?: string;
	}): void {
		if (this.disposed) return;

		const existing = this.byAssetId.get(assetId) ?? [];
		const next: DerivedAssetState = { kind, assetId, status, error };
		const updated = [...existing.filter((s) => s.kind !== kind), next];
		this.byAssetId.set(assetId, updated);
		// Snapshot the manifest reference so useSyncExternalStore detects a change.
		this.manifest = { byAssetId: this.byAssetId };
		this.notify();
	}

	private notify(): void {
		for (const fn of this.listeners) {
			fn();
		}
	}
}
