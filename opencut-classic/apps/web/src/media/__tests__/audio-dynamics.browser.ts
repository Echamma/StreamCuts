import { createTrackCompressor, renderDynamicsWindow } from "../audio-dynamics";
import {
	createAudioMasteringChain,
	getAudioBufferPeak,
} from "../audio-mastering";
import type { TrackCompressorSettings } from "@/timeline";

const sampleRate = 44100;
const length = sampleRate * 2;
const settings: TrackCompressorSettings = {
	enabled: true,
	thresholdDb: -24,
	ratio: 8,
	attackSeconds: 0.003,
	releaseSeconds: 0.1,
	kneeDb: 0,
};

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function tone(amplitude: number, phase = 0): AudioBuffer {
	const context = new OfflineAudioContext(2, length, sampleRate);
	const buffer = context.createBuffer(2, length, sampleRate);
	for (let channel = 0; channel < 2; channel++) {
		const data = buffer.getChannelData(channel);
		for (let index = 0; index < length; index++) {
			data[index] =
				amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate + phase);
		}
	}
	return buffer;
}

function rms(buffer: AudioBuffer, start: number, end: number): number {
	const data = buffer.getChannelData(0);
	let sum = 0;
	for (let index = start; index < end; index++) sum += data[index] ** 2;
	return Math.sqrt(sum / (end - start));
}

async function liveGraph(buffer: AudioBuffer): Promise<AudioBuffer> {
	const context = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
	const { input } = createAudioMasteringChain({
		audioContext: context,
		destination: context.destination,
	});
	const compressor = createTrackCompressor({ audioContext: context, settings });
	assert(compressor !== null, "enabled compressor was not created");
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(compressor!);
	compressor!.connect(input);
	source.start();
	return context.startRendering();
}

async function run(): Promise<void> {
	const loud = tone(0.8);
	const tracks = new Map([["dialog", loud]]);
	const dry = await renderDynamicsWindow({
		trackBuffers: tracks,
		trackCompressors: new Map(),
		sampleRate,
		windowLength: length,
	});
	const wet = await renderDynamicsWindow({
		trackBuffers: tracks,
		trackCompressors: new Map([["dialog", settings]]),
		sampleRate,
		windowLength: length,
	});
	const begin = sampleRate;
	const end = sampleRate + sampleRate / 2;
	assert(
		rms(wet.buffer, begin, end) < rms(dry.buffer, begin, end) * 0.65,
		"track compressor did not reduce a sustained loud tone",
	);

	const live = await liveGraph(loud);
	const offlineData = wet.buffer.getChannelData(0);
	const liveData = live.getChannelData(0);
	let maxDifference = 0;
	for (let index = 0; index < length; index++) {
		maxDifference = Math.max(
			maxDifference,
			Math.abs(offlineData[index] - liveData[index]),
		);
	}
	assert(
		maxDifference < 1e-5,
		`playback/export graph mismatch: ${maxDifference}`,
	);

	const twoTracks = await renderDynamicsWindow({
		trackBuffers: new Map([
			["dialog", tone(0.9)],
			["music", tone(0.9)],
		]),
		trackCompressors: new Map(),
		sampleRate,
		windowLength: length,
	});
	const peak = getAudioBufferPeak({ audioBuffer: twoTracks.buffer });
	assert(peak > 0.5 && peak <= 0.981, `master peak exceeded ceiling: ${peak}`);

	const first = contextSlice(loud, 0, sampleRate);
	const second = contextSlice(loud, sampleRate, sampleRate);
	const firstChunk = await renderDynamicsWindow({
		trackBuffers: new Map([["dialog", first]]),
		trackCompressors: new Map([["dialog", settings]]),
		sampleRate,
		windowLength: sampleRate,
	});
	const secondChunk = await renderDynamicsWindow({
		trackBuffers: new Map([["dialog", second]]),
		trackCompressors: new Map([["dialog", settings]]),
		previousTails: firstChunk.tails,
		sampleRate,
		windowLength: sampleRate,
	});
	const chunkRms = rms(secondChunk.buffer, sampleRate / 4, sampleRate / 2);
	const fullRms = rms(
		wet.buffer,
		sampleRate + sampleRate / 4,
		sampleRate + sampleRate / 2,
	);
	assert(
		Math.abs(chunkRms - fullRms) < fullRms * 0.03,
		"compressor reset at export window boundary",
	);
}

function contextSlice(
	buffer: AudioBuffer,
	offset: number,
	size: number,
): AudioBuffer {
	const context = new OfflineAudioContext(2, size, sampleRate);
	const output = context.createBuffer(2, size, sampleRate);
	for (let channel = 0; channel < 2; channel++) {
		output.copyToChannel(
			buffer.getChannelData(channel).subarray(offset, offset + size),
			channel,
		);
	}
	return output;
}

run()
	.then(() => {
		document.body.textContent = "AUDIO_DYNAMICS_PASS";
	})
	.catch((error: unknown) => {
		document.body.textContent = `AUDIO_DYNAMICS_FAIL: ${String(error)}`;
	});
