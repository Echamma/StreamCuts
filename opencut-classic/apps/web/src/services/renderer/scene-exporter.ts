import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	CanvasSource,
	AudioBufferSource,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	target?: BufferTarget | StreamTarget;
	writeAudioToSource?: ({
		audioSource,
	}: {
		audioSource: AudioBufferSource;
	}) => Promise<boolean>;
};

const EXPORT_AUDIO_SAMPLE_RATE = 44100;
const EXPORT_AUDIO_CHANNELS = 2;
const KEY_FRAME_INTERVAL_SECONDS = 2;
const VIDEO_QUALITY_MULTIPLIER: Record<ExportQuality, number> = {
	low: 0.7,
	medium: 1,
	high: 1.45,
	very_high: 2.1,
};
const AUDIO_BITRATE_BY_QUALITY: Record<ExportQuality, number> = {
	low: 96000,
	medium: 128000,
	high: 192000,
	very_high: 256000,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [result: SceneExportResult];
	error: [error: Error];
	cancelled: [];
};

export interface SceneExportResult {
	buffer?: ArrayBuffer;
	wroteToFile: boolean;
}

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private target: BufferTarget | StreamTarget;
	private writeAudioToSource?: ({
		audioSource,
	}: {
		audioSource: AudioBufferSource;
	}) => Promise<boolean>;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		target,
		writeAudioToSource,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.target = target ?? new BufferTarget();
		this.writeAudioToSource = writeAudioToSource;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	/**
	 * Copy the freshly-composited GPU frame onto the 2D capture surface the
	 * encoder reads from.
	 *
	 * `wasmCompositor.render()` submits GPU work synchronously but exposes no
	 * completion signal. Capturing the WebGPU canvas *directly* therefore races
	 * the GPU: the export loop renders and captures back-to-back with no
	 * presentation cycle, so some frames get snapshotted mid-draw and surface as
	 * a random duplicated/torn frame. (Preview never hits this — it already
	 * draws through a 2D canvas, and the browser presents each frame on its own
	 * refresh. That asymmetry is exactly why the artefact was export-only.)
	 *
	 * Drawing through a 2D context resolves the pending GPU work as part of the
	 * draw and leaves the encoder reading a stable, already-settled surface —
	 * the same approach preview takes, and cheap enough to run every frame (no
	 * per-frame allocation, unlike snapshotting to an `ImageBitmap`).
	 */
	private captureCompositedFrame(compositorCanvas: HTMLCanvasElement): void {
		const { context, width, height } = this.renderer;
		context.drawImage(compositorCanvas, 0, 0, width, height);
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<SceneExportResult | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" || this.format === "webm-av1"
				? new WebMOutputFormat()
				: new Mp4OutputFormat(
						this.target instanceof StreamTarget ? { fastStart: false } : undefined,
					);

		const output = new Output({
			format: outputFormat,
			target: this.target,
		});

		const videoCodec: "avc" | "vp9" | "av1" =
			this.format === "webm-av1"
				? "av1"
				: this.format === "webm"
					? "vp9"
					: "avc";
		const videoBitrate = getTargetVideoBitrate({
			codec: videoCodec,
			width: this.renderer.width,
			height: this.renderer.height,
			fps: fpsFloat,
			quality: this.quality,
		});
		// Encode from the 2D capture surface rather than the live WebGPU canvas —
		// see `captureCompositedFrame` for why that ordering matters.
		const compositorCanvas = this.renderer.getOutputCanvas();
		const videoSource = new CanvasSource(this.renderer.canvas, {
			codec: videoCodec,
			bitrate: videoBitrate,
			bitrateMode: "variable",
			latencyMode: "quality",
			contentHint: "detail",
			keyFrameInterval: KEY_FRAME_INTERVAL_SECONDS,
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && (this.audioBuffer || this.writeAudioToSource)) {
			let audioCodec: "aac" | "opus" =
			this.format === "webm" || this.format === "webm-av1" ? "opus" : "aac";
			let audioBitrate = getTargetAudioBitrate({
				codec: audioCodec,
				quality: this.quality,
			});

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer?.sampleRate ?? EXPORT_AUDIO_SAMPLE_RATE,
					numberOfChannels:
						this.audioBuffer?.numberOfChannels ?? EXPORT_AUDIO_CHANNELS,
					bitrate: audioBitrate,
				});
				if (!supported) {
					audioCodec = "opus";
					audioBitrate = getTargetAudioBitrate({
						codec: audioCodec,
						quality: this.quality,
					});
				}
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: audioBitrate,
				bitrateMode: "variable",
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource) {
			if (this.writeAudioToSource) {
				await this.writeAudioToSource({ audioSource });
			} else if (this.audioBuffer) {
				await audioSource.add(this.audioBuffer);
			}
			audioSource.close();
		}

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		let prevAddPromise: Promise<void> = Promise.resolve();

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await prevAddPromise.catch(() => {});
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });

			// Wait for previous frame's encoder backpressure before submitting this one.
			// VideoFrame pixels are captured synchronously inside videoSource.add(), so
			// the canvas is safe to overwrite as soon as add() has been called.
			await prevAddPromise;
			// `exact`: never accept a stale source frame. The frame cache is shared
			// with the preview, which keeps rendering while we export and would
			// otherwise supersede our requests — baking its frame into the file.
			await this.renderer.render({
				node: rootNode,
				time: timeTicks,
				exact: true,
			});
			// Settle the composited frame onto the capture surface before the
			// encoder reads it, so it can never snapshot a half-drawn GPU frame.
			this.captureCompositedFrame(compositorCanvas);
			prevAddPromise = videoSource.add(timeSeconds, 1 / fpsFloat);

			this.emit("progress", i / frameCount);
		}

		await prevAddPromise;

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		this.emit("progress", 0.99);
		await output.finalize();
		this.emit("progress", 1);

		if (this.target instanceof BufferTarget) {
			const buffer = this.target.buffer;
			if (!buffer) {
				this.emit("error", new Error("Failed to export video"));
				return null;
			}

			const result = {
				buffer,
				wroteToFile: false,
			};
			this.emit("complete", result);
			return result;
		}

		const result = {
			wroteToFile: true,
		};
		this.emit("complete", result);
		return result;
	}
}

function getTargetVideoBitrate({
	codec,
	width,
	height,
	fps,
	quality,
}: {
	codec: "avc" | "vp9" | "av1";
	width: number;
	height: number;
	fps: number;
	quality: ExportQuality;
}): number {
	const safeFps = Math.max(1, fps);
	// AV1 is ~30% more efficient than VP9 at the same visual quality — target a
	// lower bits-per-pixel so users see a smaller file, not a bigger one, when
	// they pick AV1. VP9/H.264 numbers are unchanged.
	const bitsPerPixelPerFrame =
		codec === "av1"
			? 0.06 * VIDEO_QUALITY_MULTIPLIER[quality]
			: codec === "vp9"
				? 0.085 * VIDEO_QUALITY_MULTIPLIER[quality]
				: 0.13 * VIDEO_QUALITY_MULTIPLIER[quality];
	const rawBitrate = width * height * safeFps * bitsPerPixelPerFrame;
	const minimumBitrate =
		codec === "av1" ? 1_500_000 : codec === "vp9" ? 2_000_000 : 3_500_000;
	const maximumBitrate =
		codec === "av1" ? 50_000_000 : codec === "vp9" ? 60_000_000 : 80_000_000;

	return roundBitrate({
		bitrate: Math.max(minimumBitrate, Math.min(maximumBitrate, rawBitrate)),
	});
}

function getTargetAudioBitrate({
	codec,
	quality,
}: {
	codec: "aac" | "opus";
	quality: ExportQuality;
}): number {
	if (codec === "opus") {
		const opusBitrateByQuality: Record<ExportQuality, number> = {
			low: 64000,
			medium: 96000,
			high: 160000,
			very_high: 224000,
		};
		return opusBitrateByQuality[quality];
	}

	return AUDIO_BITRATE_BY_QUALITY[quality];
}

function roundBitrate({ bitrate }: { bitrate: number }): number {
	return Math.max(1_000, Math.round(bitrate / 1_000) * 1_000);
}
