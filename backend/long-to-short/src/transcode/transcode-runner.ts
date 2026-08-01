import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildAudioExportArgs,
	buildOptimizedArgs,
	buildProbeArgs,
	buildProResArgs,
	buildProxyArgs,
	parseProbeJson,
	type AudioExportArgsOptions,
	type OptimizedArgsOptions,
	type ProbeSummary,
	type ProResProfile,
	type ProxyArgsOptions,
} from "./transcode-args";

const execFileAsync = promisify(execFile);

/**
 * Thin ffmpeg/ffprobe runner for the transcode jobs. Binary paths are passed in
 * (the NestJS service resolves them from `ffmpeg-static`/`ffprobe-static`; the
 * verification harness passes the system binaries), so this module has no
 * external dependency and runs anywhere Node + ffmpeg do.
 */

// ffmpeg logs progress to stderr and can emit a lot on long inputs.
const MAX_BUFFER = 1024 * 1024 * 64;

async function runFfmpeg({
	ffmpegPath,
	args,
}: {
	ffmpegPath: string;
	args: string[];
}): Promise<void> {
	await execFileAsync(ffmpegPath, args, {
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
	});
}

/** Probe a media file down to the codec/dimension/duration summary. */
export async function probeMedia({
	ffprobePath,
	filePath,
}: {
	ffprobePath: string;
	filePath: string;
}): Promise<ProbeSummary> {
	const { stdout } = await execFileAsync(
		ffprobePath,
		buildProbeArgs({ filePath }),
		{ encoding: "utf8", maxBuffer: MAX_BUFFER },
	);
	return parseProbeJson({ json: stdout });
}

/** Transcode a source file to a 540p (default) H.264 editing proxy (MED-005). */
export async function transcodeToProxy({
	ffmpegPath,
	options,
}: {
	ffmpegPath: string;
	options: ProxyArgsOptions;
}): Promise<void> {
	await runFfmpeg({ ffmpegPath, args: buildProxyArgs(options) });
}

/** Transcode a source file to an all-intra, source-resolution H.264 optimized
 * intermediate (MED-006). */
export async function transcodeToOptimized({
	ffmpegPath,
	options,
}: {
	ffmpegPath: string;
	options: OptimizedArgsOptions;
}): Promise<void> {
	await runFfmpeg({ ffmpegPath, args: buildOptimizedArgs(options) });
}

/** Export the audio track of a source file to a delivery format (DEL-007). */
export async function transcodeToAudio({
	ffmpegPath,
	options,
}: {
	ffmpegPath: string;
	options: AudioExportArgsOptions;
}): Promise<void> {
	await runFfmpeg({ ffmpegPath, args: buildAudioExportArgs(options) });
}

/** Transcode a source file to Apple ProRes (DEL-003). */
export async function transcodeToProRes({
	ffmpegPath,
	inputPath,
	outputPath,
	profile,
}: {
	ffmpegPath: string;
	inputPath: string;
	outputPath: string;
	profile?: ProResProfile;
}): Promise<void> {
	await runFfmpeg({
		ffmpegPath,
		args: buildProResArgs({ inputPath, outputPath, profile }),
	});
}
