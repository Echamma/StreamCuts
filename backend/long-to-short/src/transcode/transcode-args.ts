/**
 * Pure ffmpeg argument builders for the transcode jobs (DEL-003 pro codecs,
 * MED-005 proxies). No I/O, no ffmpeg invocation — just the argument vectors —
 * so they unit-test without a binary and produce byte-identical commands for
 * both the NestJS service and the verification harness.
 *
 * Every builder maps video stream 0 and *optionally* audio (`0:a?`), matching
 * the existing long-to-short pipeline, so a silent source transcodes without
 * error.
 */

/**
 * Apple ProRes profiles, in ascending quality/size. Values are the numbers
 * ffmpeg's `prores_ks -profile:v` expects; `4444`/`4444xq` carry alpha and use
 * a 4:4:4 pixel format.
 */
export type ProResProfile = "proxy" | "lt" | "standard" | "hq" | "4444" | "4444xq";

const PRORES_PROFILE_NUMBER: Record<ProResProfile, number> = {
	proxy: 0,
	lt: 1,
	standard: 2,
	hq: 3,
	"4444": 4,
	"4444xq": 5,
};

/** 4:4:4 profiles keep alpha; the 422 profiles do not. */
function proResPixelFormat(profile: ProResProfile): string {
	return profile === "4444" || profile === "4444xq"
		? "yuva444p10le"
		: "yuv422p10le";
}

export interface ProxyArgsOptions {
	inputPath: string;
	outputPath: string;
	/** Target height in pixels; width is derived to keep aspect (even). */
	height?: number;
	/** x264 constant-rate-factor (lower = higher quality/size). */
	crf?: number;
}

/**
 * H.264 editing-proxy transcode (MED-005). Scales to `height` (default 540p),
 * keeping aspect with an even width (`scale=-2:H`), 8-bit 4:2:0, `+faststart`
 * for progressive playback, AAC audio.
 *
 * Deliberately **all-intra** (`-g 1 -keyint_min 1 -bf 0`), which is what makes
 * this an editing proxy rather than merely a small file. Camera and screen
 * captures routinely use multi-second keyframe intervals, so displaying one
 * arbitrary frame means decoding every frame back to the previous keyframe —
 * the reason scrubbing such media crawls. With every frame a keyframe, a seek
 * decodes exactly one frame. This is why the professional proxy formats
 * (ProRes Proxy, DNxHR LB) are all-intra too.
 *
 * Frame rate and duration are untouched — only the picture is scaled — so the
 * proxy stays frame-aligned with its master and edits conform without drift.
 */
export function buildProxyArgs({
	inputPath,
	outputPath,
	height = 540,
	crf = 23,
}: ProxyArgsOptions): string[] {
	return [
		"-y",
		"-i",
		inputPath,
		"-map",
		"0:v:0",
		"-map",
		"0:a?",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		String(crf),
		"-vf",
		`scale=-2:${height}`,
		// Every frame a keyframe and no B-frames → any frame decodes standalone,
		// so scrubbing never pays for a long GOP.
		"-g",
		"1",
		"-keyint_min",
		"1",
		"-bf",
		"0",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-movflags",
		"+faststart",
		outputPath,
	];
}

export interface ProResArgsOptions {
	inputPath: string;
	outputPath: string;
	profile?: ProResProfile;
}

/**
 * Apple ProRes mastering transcode (DEL-003). Uses `prores_ks` at the requested
 * profile with a matching 10-bit pixel format and 16-bit PCM audio in a `.mov`
 * — the interchange format browsers can't encode natively, which is why this
 * runs server-side.
 */
export function buildProResArgs({
	inputPath,
	outputPath,
	profile = "standard",
}: ProResArgsOptions): string[] {
	return [
		"-y",
		"-i",
		inputPath,
		"-map",
		"0:v:0",
		"-map",
		"0:a?",
		"-c:v",
		"prores_ks",
		"-profile:v",
		String(PRORES_PROFILE_NUMBER[profile]),
		"-pix_fmt",
		proResPixelFormat(profile),
		"-c:a",
		"pcm_s16le",
		outputPath,
	];
}

export interface OptimizedArgsOptions {
	inputPath: string;
	outputPath: string;
	/** x264 constant-rate-factor (lower = higher quality/size). */
	crf?: number;
}

/**
 * Edit-friendly "optimized media" transcode (MED-006): source-resolution,
 * all-intra H.264 — every frame is a keyframe (`-g 1`), so any frame seeks
 * instantly — for source codecs the browser decodes poorly (HEVC, VP9, …).
 * Larger than a proxy (no downscale), lighter and more compatible than ProRes.
 */
export function buildOptimizedArgs({
	inputPath,
	outputPath,
	crf = 18,
}: OptimizedArgsOptions): string[] {
	return [
		"-y",
		"-i",
		inputPath,
		"-map",
		"0:v:0",
		"-map",
		"0:a?",
		"-c:v",
		"libx264",
		"-preset",
		"fast",
		"-crf",
		String(crf),
		// Every frame a keyframe and no B-frames → strictly all-intra, so any
		// frame decodes standalone (fast, exact seeking).
		"-g",
		"1",
		"-keyint_min",
		"1",
		"-bf",
		"0",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"192k",
		"-movflags",
		"+faststart",
		outputPath,
	];
}

/** Audio-only delivery formats (DEL-007). Lossy (mp3/aac) honour `bitrate`;
 * lossless (wav/flac) ignore it. */
export type AudioExportFormat = "mp3" | "aac" | "wav" | "flac";

/** Container extension written for each audio-export format. */
export const AUDIO_EXPORT_EXTENSION: Record<AudioExportFormat, string> = {
	mp3: ".mp3",
	aac: ".m4a",
	wav: ".wav",
	flac: ".flac",
};

export interface AudioExportArgsOptions {
	inputPath: string;
	outputPath: string;
	format: AudioExportFormat;
	/** Bitrate for lossy formats (e.g. "192k"); ignored for wav/flac. */
	bitrate?: string;
}

/**
 * Audio-only export (DEL-007): drop video (`-vn`), map the first audio stream,
 * and encode to the requested delivery format — MP3/AAC (lossy, `bitrate`) or
 * WAV/FLAC (lossless). Pulls a stem or podcast track out of a clip.
 */
export function buildAudioExportArgs({
	inputPath,
	outputPath,
	format,
	bitrate = "192k",
}: AudioExportArgsOptions): string[] {
	const args = ["-y", "-i", inputPath, "-vn", "-map", "0:a:0"];
	switch (format) {
		case "mp3":
			args.push("-c:a", "libmp3lame", "-b:a", bitrate);
			break;
		case "aac":
			args.push("-c:a", "aac", "-b:a", bitrate);
			break;
		case "wav":
			args.push("-c:a", "pcm_s16le");
			break;
		case "flac":
			args.push("-c:a", "flac");
			break;
	}
	args.push(outputPath);
	return args;
}

/** ffprobe args that emit one line of JSON describing the first video + audio
 * streams and the container duration — the shape {@link parseProbeJson} reads. */
export function buildProbeArgs({ filePath }: { filePath: string }): string[] {
	return [
		"-v",
		"error",
		"-show_entries",
		"stream=codec_type,codec_name,width,height,r_frame_rate:format=duration",
		"-of",
		"json",
		filePath,
	];
}

export interface ProbeSummary {
	videoCodec: string | null;
	audioCodec: string | null;
	width: number | null;
	height: number | null;
	durationSeconds: number | null;
	/**
	 * Frame rate exactly as ffprobe reports it (`"60/1"`, `"30000/1001"`), kept
	 * as the rational string so an editing proxy can be proven to match its
	 * master frame-for-frame — a proxy that drifts in frame rate silently
	 * misplaces every edit made against it.
	 */
	frameRate: string | null;
}

interface RawProbeStream {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	r_frame_rate?: string;
}

interface RawProbe {
	streams?: RawProbeStream[];
	format?: { duration?: string };
}

/** Reduce ffprobe's JSON to the fields the transcode checks care about. */
export function parseProbeJson({ json }: { json: string }): ProbeSummary {
	const parsed = JSON.parse(json) as RawProbe;
	const streams = parsed.streams ?? [];
	const video = streams.find((stream) => stream.codec_type === "video");
	const audio = streams.find((stream) => stream.codec_type === "audio");
	const duration = parsed.format?.duration;

	return {
		videoCodec: video?.codec_name ?? null,
		audioCodec: audio?.codec_name ?? null,
		width: video?.width ?? null,
		height: video?.height ?? null,
		durationSeconds: duration === undefined ? null : Number(duration),
		frameRate: video?.r_frame_rate ?? null,
	};
}
