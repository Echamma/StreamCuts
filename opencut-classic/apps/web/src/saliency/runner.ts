import type { ScalarAnimationKey, ScalarChannel } from "@/animation/types";
import { videoCache } from "@/services/video-cache/service";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";

/** Sample rate at which the analyzer ingests frames. Matches the Rust crate
 * default (4 Hz) — fast enough to track a moving speaker, slow enough not to
 * compete with the preview scheduler's perf budget. */
const SAMPLE_RATE_HZ = 4;

/** Downscale large source frames before luma extraction. The analyzer's grid
 * is 8x8 so we don't need much resolution to find the salient cell. 320 px
 * on the long edge gives us a ~40px-per-cell budget at 16:9. */
const ANALYZE_MAX_DIMENSION = 320;

export interface ReframeChannels {
	"reframe.x": ScalarChannel;
	"reframe.y": ScalarChannel;
}

interface SaliencyAnalyzerLike {
	analyze(luma: Uint8Array): { x: number; y: number; scale: number };
	reset(): void;
}

interface SaliencyAnalyzerConstructorLike {
	new (options: {
		width: number;
		height: number;
		sampleRateHz?: number;
		tauSeconds?: number;
	}): SaliencyAnalyzerLike;
}

let analyzerCtorCache:
	| SaliencyAnalyzerConstructorLike
	| null
	| "unavailable" = null;

async function getAnalyzerCtor(): Promise<SaliencyAnalyzerConstructorLike | null> {
	if (analyzerCtorCache === "unavailable") return null;
	if (analyzerCtorCache) return analyzerCtorCache;
	try {
		// SaliencyAnalyzer ships with opencut-wasm once `bun run build:wasm` is
		// run after the Rust saliency crate lands. Until then this lookup is
		// undefined and the runner falls back to a no-op so the editor stays
		// usable without auto-reframe.
		const mod = (await import("opencut-wasm")) as unknown as Record<
			string,
			unknown
		>;
		const ctor = mod.SaliencyAnalyzer as
			| SaliencyAnalyzerConstructorLike
			| undefined;
		if (!ctor) {
			analyzerCtorCache = "unavailable";
			return null;
		}
		analyzerCtorCache = ctor;
		return ctor;
	} catch {
		analyzerCtorCache = "unavailable";
		return null;
	}
}

function extractLuma({
	canvas,
	maxDimension,
}: {
	canvas: CanvasImageSource;
	maxDimension: number;
}): { luma: Uint8Array; width: number; height: number } | null {
	const sourceWidth = "width" in canvas ? Number(canvas.width) : 0;
	const sourceHeight = "height" in canvas ? Number(canvas.height) : 0;
	if (sourceWidth <= 0 || sourceHeight <= 0) return null;

	const scale = Math.min(
		1,
		maxDimension / Math.max(sourceWidth, sourceHeight),
	);
	const width = Math.max(1, Math.round(sourceWidth * scale));
	const height = Math.max(1, Math.round(sourceHeight * scale));

	const offscreen = new OffscreenCanvas(width, height);
	const ctx = offscreen.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(canvas, 0, 0, width, height);
	const rgba = ctx.getImageData(0, 0, width, height).data;
	const luma = new Uint8Array(width * height);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
		// BT.601 luma — same coefficients FFmpeg uses for yuv420p conversion.
		luma[j] =
			(rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
	}
	return { luma, width, height };
}

function buildHoldKey({
	id,
	time,
	value,
}: {
	id: string;
	time: MediaTime;
	value: number;
}): ScalarAnimationKey {
	return {
		id,
		time,
		value,
		segmentToNext: "linear",
		tangentMode: "auto",
	};
}

/** Walk a media asset's video frames at SAMPLE_RATE_HZ, feed each frame's
 * luma into the wasm saliency analyzer, and return reframe.x/.y keyframe
 * channels. Returns null when the analyzer is unavailable (wasm not yet
 * rebuilt) or when frame decoding fails. */
export async function analyzeMediaForReframe({
	mediaId,
	file,
	durationSeconds,
	signal,
}: {
	mediaId: string;
	file: File;
	durationSeconds: number;
	signal?: AbortSignal;
}): Promise<ReframeChannels | null> {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

	const Ctor = await getAnalyzerCtor();
	if (!Ctor) return null;

	// Probe the first frame to learn the source size for the analyzer.
	const probe = await videoCache.getFrameAt({ mediaId, file, time: 0 });
	if (!probe) return null;
	const probeLuma = extractLuma({
		canvas: probe.canvas,
		maxDimension: ANALYZE_MAX_DIMENSION,
	});
	if (!probeLuma) return null;

	const analyzer = new Ctor({
		width: probeLuma.width,
		height: probeLuma.height,
		sampleRateHz: SAMPLE_RATE_HZ,
	});

	const xKeys: ScalarAnimationKey[] = [];
	const yKeys: ScalarAnimationKey[] = [];
	const stepSeconds = 1 / SAMPLE_RATE_HZ;
	let index = 0;
	for (let t = 0; t <= durationSeconds; t += stepSeconds, index += 1) {
		if (signal?.aborted) return null;
		const frame = await videoCache.getFrameAt({ mediaId, file, time: t });
		if (!frame) continue;
		const extracted = extractLuma({
			canvas: frame.canvas,
			maxDimension: ANALYZE_MAX_DIMENSION,
		});
		if (!extracted) continue;
		// Source dimensions are fixed for the asset; if the probe size differs
		// from a later frame's (shouldn't happen for a single video), the
		// analyzer will error and we bail out.
		if (
			extracted.width !== probeLuma.width ||
			extracted.height !== probeLuma.height
		) {
			continue;
		}
		let point: { x: number; y: number; scale: number };
		try {
			point = analyzer.analyze(extracted.luma);
		} catch {
			analyzer.reset();
			continue;
		}
		const time = mediaTimeFromSeconds({ seconds: t });
		xKeys.push(
			buildHoldKey({ id: `reframe-x-${index}`, time, value: point.x }),
		);
		yKeys.push(
			buildHoldKey({ id: `reframe-y-${index}`, time, value: point.y }),
		);
	}

	if (xKeys.length === 0) return null;

	return {
		"reframe.x": { keys: xKeys },
		"reframe.y": { keys: yKeys },
	};
}
