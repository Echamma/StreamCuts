import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { getWaveformSourceKeyForAsset } from "@/media/asset-source";
import { waveformCache } from "@/services/waveform-cache/service";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DerivedAssetKind = "waveform";

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

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private handleMediaChange = (): void => {
		const assets = this.editor.media.getAssets();
		for (const asset of assets) {
			if (this.queued.has(asset.id)) continue;
			if (!this.needsWaveform(asset)) continue;

			this.queued.add(asset.id);
			this.enqueue(asset);
		}
	};

	private needsWaveform(asset: MediaAsset): boolean {
		if (asset.type === "audio") return true;
		if (asset.type === "video" && asset.hasAudio !== false) return true;
		return false;
	}

	private enqueue(asset: MediaAsset): void {
		this.taskQueue.push(() => this.prepareWaveform(asset));
		this.runQueue();
	}

	private runQueue(): void {
		if (this.isRunning || this.disposed) return;
		const task = this.taskQueue.shift();
		if (!task) return;

		this.isRunning = true;
		task()
			.catch(() => {
				// prepareWaveform already records the error state
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
