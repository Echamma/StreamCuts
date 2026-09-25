import type { TrackCompressorSettings } from "@/timeline";
import { createAudioMasteringChain } from "@/media/audio-mastering";

const DYNAMICS_PREROLL_SECONDS = 1;

export const DEFAULT_TRACK_COMPRESSOR: TrackCompressorSettings = {
	enabled: false,
	thresholdDb: -18,
	ratio: 4,
	attackSeconds: 0.01,
	releaseSeconds: 0.25,
	kneeDb: 6,
};

function bounded(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(min, Math.min(max, value))
		: fallback;
}

/** Web Audio enforces these ranges; sanitize saved projects before touching a node. */
export function resolveTrackCompressor(
	settings: TrackCompressorSettings | undefined,
): TrackCompressorSettings {
	return {
		enabled: settings?.enabled === true,
		thresholdDb: bounded(
			settings?.thresholdDb,
			DEFAULT_TRACK_COMPRESSOR.thresholdDb,
			-100,
			0,
		),
		ratio: bounded(settings?.ratio, DEFAULT_TRACK_COMPRESSOR.ratio, 1, 20),
		attackSeconds: bounded(
			settings?.attackSeconds,
			DEFAULT_TRACK_COMPRESSOR.attackSeconds,
			0,
			1,
		),
		releaseSeconds: bounded(
			settings?.releaseSeconds,
			DEFAULT_TRACK_COMPRESSOR.releaseSeconds,
			0,
			1,
		),
		kneeDb: bounded(settings?.kneeDb, DEFAULT_TRACK_COMPRESSOR.kneeDb, 0, 40),
	};
}

export function createTrackCompressor({
	audioContext,
	settings,
}: {
	audioContext: BaseAudioContext;
	settings: TrackCompressorSettings | undefined;
}): DynamicsCompressorNode | null {
	const resolved = resolveTrackCompressor(settings);
	if (!resolved.enabled) return null;
	const compressor = audioContext.createDynamicsCompressor();
	compressor.threshold.value = resolved.thresholdDb;
	compressor.ratio.value = resolved.ratio;
	compressor.attack.value = resolved.attackSeconds;
	compressor.release.value = resolved.releaseSeconds;
	compressor.knee.value = resolved.kneeDb;
	return compressor;
}

/**
 * Render the same track-compressor → master-limiter graph as playback. A short
 * tail from the previous window warms the compressor envelopes before each
 * streaming export window, avoiding a gain jump at the boundary.
 */
export async function renderDynamicsWindow({
	trackBuffers,
	trackCompressors,
	previousTails = new Map(),
	sampleRate,
	windowLength,
}: {
	trackBuffers: Map<string, AudioBuffer>;
	trackCompressors: Map<string, TrackCompressorSettings | undefined>;
	previousTails?: Map<string, AudioBuffer>;
	sampleRate: number;
	windowLength: number;
}): Promise<{ buffer: AudioBuffer; tails: Map<string, AudioBuffer> }> {
	const prefixLength = Math.max(
		0,
		...[...previousTails.values()].map((tail) => tail.length),
	);
	const offline = new OfflineAudioContext(
		2,
		prefixLength + windowLength,
		sampleRate,
	);
	const { input: master } = createAudioMasteringChain({
		audioContext: offline,
		destination: offline.destination,
	});
	const tails = new Map<string, AudioBuffer>();
	const trackIds = new Set([...previousTails.keys(), ...trackBuffers.keys()]);
	const tailLength = Math.min(
		windowLength,
		Math.ceil(DYNAMICS_PREROLL_SECONDS * sampleRate),
	);

	for (const trackId of trackIds) {
		const current = trackBuffers.get(trackId);
		const previous = previousTails.get(trackId);
		const sourceBuffer = offline.createBuffer(
			2,
			prefixLength + windowLength,
			sampleRate,
		);
		for (let channel = 0; channel < 2; channel++) {
			if (previous) {
				sourceBuffer.copyToChannel(
					previous.getChannelData(channel),
					channel,
					prefixLength - previous.length,
				);
			}
			if (current) {
				sourceBuffer.copyToChannel(
					current.getChannelData(channel),
					channel,
					prefixLength,
				);
			}
		}
		const source = offline.createBufferSource();
		source.buffer = sourceBuffer;
		const compressor = createTrackCompressor({
			audioContext: offline,
			settings: trackCompressors.get(trackId),
		});
		if (compressor) {
			source.connect(compressor);
			compressor.connect(master);
		} else {
			source.connect(master);
		}
		source.start(0);

		if (current && tailLength > 0) {
			const tail = offline.createBuffer(2, tailLength, sampleRate);
			for (let channel = 0; channel < 2; channel++) {
				tail.copyToChannel(
					current.getChannelData(channel).subarray(current.length - tailLength),
					channel,
				);
			}
			tails.set(trackId, tail);
		}
	}

	const rendered = await offline.startRendering();
	const buffer = offline.createBuffer(2, windowLength, sampleRate);
	for (let channel = 0; channel < 2; channel++) {
		buffer.copyToChannel(
			rendered.getChannelData(channel).subarray(prefixLength),
			channel,
		);
	}
	return { buffer, tails };
}
