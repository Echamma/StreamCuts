import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type {
	ExportOptions,
	ExportPhase,
	ExportResult,
	ExportOutputTarget,
} from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import {
	addTimelineAudioToSource,
	collectAudibleCandidates,
	timelineHasAudio,
	TimelineAudioRenderCancelledError,
} from "@/media/audio";
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { formatTimecode } from "opencut-wasm";
import { downloadBlob } from "@/utils/browser";
import { StreamTarget } from "mediabunny";

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		tracks: tracksOverride,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		tracks?: SceneTracks;
		onProgress?: ({ progress, phase, statusText }: { progress: number; phase?: ExportPhase; statusText?: string }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio } = options;

		try {
			const tracks = tracksOverride ?? this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			const shouldIncludeAudio =
				!!includeAudio && timelineHasAudio({ tracks, mediaAssets });
			const audioWeight = estimateAudioWeight({
				tracks,
				mediaAssets,
				includeAudio: shouldIncludeAudio,
			});

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			const outputTarget = createExporterTarget({
				outputTarget: options.outputTarget,
			});
			let cancelled = false;
			let exporter: SceneExporter;
			exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				shouldIncludeAudio,
				target: outputTarget,
				writeAudioToSource: shouldIncludeAudio
					? async ({ audioSource }) => {
							onProgress?.({
								progress: 0,
								phase: "audio",
								statusText: "Preparing audio...",
							});
							try {
								return await addTimelineAudioToSource({
									tracks,
									mediaAssets,
									duration,
									audioSource,
									onProgress: (fraction) =>
										onProgress?.({
											progress: fraction * audioWeight,
											phase: "audio",
											statusText: "Preparing audio...",
										}),
									shouldCancel: onCancel,
								});
							} catch (error) {
								if (error instanceof TimelineAudioRenderCancelledError) {
									cancelled = true;
									exporter.cancel();
									return false;
								}
								throw error;
							}
						}
					: undefined,
			});

			onProgress?.({ progress: audioWeight, phase: "video", statusText: "Encoding video..." });

			exporter.on("progress", (progress) => {
				if (progress >= 0.99) {
					onProgress?.({ progress: audioWeight + progress * (1 - audioWeight), phase: "finalizing", statusText: "Finishing up..." });
				} else {
					onProgress?.({ progress: audioWeight + progress * (1 - audioWeight), phase: "video", statusText: "Encoding video..." });
				}
			});

			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const exportResult = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					return { success: false, cancelled: true };
				}

				if (!exportResult) {
					return { success: false, error: "Export failed to produce buffer" };
				}

				return {
					success: true,
					buffer: exportResult.buffer,
					wroteToFile: exportResult.wroteToFile,
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
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

function createExporterTarget({
	outputTarget,
}: {
	outputTarget?: ExportOutputTarget;
}) {
	if (outputTarget?.mode === "file-system") {
		return new StreamTarget(outputTarget.writable, {
			chunked: true,
		});
	}

	return undefined;
}

function estimateAudioWeight({
	tracks,
	mediaAssets,
	includeAudio,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	includeAudio: boolean;
}): number {
	if (!includeAudio) return 0;
	const candidates = collectAudibleCandidates({ tracks, mediaAssets });
	const hasVideoAudio = candidates.some(({ element }) => element.type === "video");
	return hasVideoAudio ? 0.3 : 0.1;
}
