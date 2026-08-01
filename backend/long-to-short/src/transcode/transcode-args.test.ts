import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUDIO_EXPORT_EXTENSION,
	buildAudioExportArgs,
	buildOptimizedArgs,
	buildProbeArgs,
	buildProResArgs,
	buildProxyArgs,
	parseProbeJson,
} from "./transcode-args";

/** Value immediately following `flag` in an ffmpeg arg vector. */
function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

test("proxy args: H.264, scaled to height, faststart, output last", () => {
	const args = buildProxyArgs({
		inputPath: "in.mov",
		outputPath: "out.mp4",
		height: 540,
	});
	assert.equal(valueAfter(args, "-c:v"), "libx264");
	assert.equal(valueAfter(args, "-vf"), "scale=-2:540");
	assert.equal(valueAfter(args, "-crf"), "23");
	assert.equal(valueAfter(args, "-pix_fmt"), "yuv420p");
	assert.equal(valueAfter(args, "-movflags"), "+faststart");
	assert.equal(valueAfter(args, "-c:a"), "aac");
	assert.equal(args[args.length - 1], "out.mp4");
	// audio is optional so a silent source still transcodes
	assert.ok(args.includes("0:a?"));
});

test("proxy args: height and crf are configurable", () => {
	const args = buildProxyArgs({
		inputPath: "in.mov",
		outputPath: "out.mp4",
		height: 720,
		crf: 18,
	});
	assert.equal(valueAfter(args, "-vf"), "scale=-2:720");
	assert.equal(valueAfter(args, "-crf"), "18");
});

test("prores args: standard profile → prores_ks -profile:v 2, 422 10-bit", () => {
	const args = buildProResArgs({ inputPath: "in.mp4", outputPath: "out.mov" });
	assert.equal(valueAfter(args, "-c:v"), "prores_ks");
	assert.equal(valueAfter(args, "-profile:v"), "2");
	assert.equal(valueAfter(args, "-pix_fmt"), "yuv422p10le");
	assert.equal(valueAfter(args, "-c:a"), "pcm_s16le");
	assert.equal(args[args.length - 1], "out.mov");
});

test("prores args: profile names map to the right numbers", () => {
	const num = (profile: Parameters<typeof buildProResArgs>[0]["profile"]) =>
		valueAfter(
			buildProResArgs({ inputPath: "i", outputPath: "o", profile }),
			"-profile:v",
		);
	assert.equal(num("proxy"), "0");
	assert.equal(num("lt"), "1");
	assert.equal(num("standard"), "2");
	assert.equal(num("hq"), "3");
	assert.equal(num("4444"), "4");
	assert.equal(num("4444xq"), "5");
});

test("prores args: 4444 profiles carry alpha (yuva444p10le)", () => {
	const args = buildProResArgs({
		inputPath: "i",
		outputPath: "o",
		profile: "4444",
	});
	assert.equal(valueAfter(args, "-pix_fmt"), "yuva444p10le");
});

test("optimized args: all-intra H.264 (-g 1), no downscale, faststart", () => {
	const args = buildOptimizedArgs({ inputPath: "in.mkv", outputPath: "out.mp4" });
	assert.equal(valueAfter(args, "-c:v"), "libx264");
	assert.equal(valueAfter(args, "-g"), "1");
	assert.equal(valueAfter(args, "-keyint_min"), "1");
	assert.equal(valueAfter(args, "-bf"), "0");
	assert.equal(valueAfter(args, "-crf"), "18");
	assert.equal(valueAfter(args, "-movflags"), "+faststart");
	// no scaling filter — output stays at source resolution
	assert.ok(!args.includes("-vf"));
	assert.equal(args[args.length - 1], "out.mp4");
});

test("audio export: mp3 drops video, maps first audio, libmp3lame + bitrate", () => {
	const args = buildAudioExportArgs({
		inputPath: "in.mp4",
		outputPath: "out.mp3",
		format: "mp3",
		bitrate: "256k",
	});
	assert.ok(args.includes("-vn"));
	assert.equal(valueAfter(args, "-map"), "0:a:0");
	assert.equal(valueAfter(args, "-c:a"), "libmp3lame");
	assert.equal(valueAfter(args, "-b:a"), "256k");
	assert.equal(args[args.length - 1], "out.mp3");
});

test("audio export: lossless formats set the right codec and no bitrate", () => {
	const wav = buildAudioExportArgs({
		inputPath: "in.mov",
		outputPath: "out.wav",
		format: "wav",
	});
	assert.equal(valueAfter(wav, "-c:a"), "pcm_s16le");
	assert.ok(!wav.includes("-b:a"));

	const flac = buildAudioExportArgs({
		inputPath: "in.mov",
		outputPath: "out.flac",
		format: "flac",
	});
	assert.equal(valueAfter(flac, "-c:a"), "flac");
	assert.ok(!flac.includes("-b:a"));
});

test("audio export: format extensions map as expected", () => {
	assert.deepEqual(AUDIO_EXPORT_EXTENSION, {
		mp3: ".mp3",
		aac: ".m4a",
		wav: ".wav",
		flac: ".flac",
	});
});

test("probe args request codec/dimensions/duration as JSON", () => {
	const args = buildProbeArgs({ filePath: "clip.mov" });
	assert.equal(valueAfter(args, "-of"), "json");
	assert.equal(args[args.length - 1], "clip.mov");
	assert.ok(valueAfter(args, "-show_entries")?.includes("codec_name"));
});

test("parseProbeJson reduces ffprobe JSON to the summary", () => {
	const json = JSON.stringify({
		streams: [
			{ codec_type: "video", codec_name: "prores", width: 1280, height: 720 },
			{ codec_type: "audio", codec_name: "pcm_s16le" },
		],
		format: { duration: "2.000000" },
	});
	assert.deepEqual(parseProbeJson({ json }), {
		videoCodec: "prores",
		audioCodec: "pcm_s16le",
		width: 1280,
		height: 720,
		durationSeconds: 2,
	});
});

test("parseProbeJson handles a video-only file", () => {
	const json = JSON.stringify({
		streams: [{ codec_type: "video", codec_name: "h264", width: 960, height: 540 }],
		format: {},
	});
	const summary = parseProbeJson({ json });
	assert.equal(summary.audioCodec, null);
	assert.equal(summary.durationSeconds, null);
	assert.equal(summary.height, 540);
});
