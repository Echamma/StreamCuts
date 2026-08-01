/**
 * Pure ffmpeg argument builders + stats parser for two-pass EBU R128 loudness
 * normalisation (FAIR-008). ffmpeg's `loudnorm` filter, run once with
 * `print_format=json`, measures the input and prints a JSON block to stderr;
 * those measurements feed a second `linear=true` pass that lands the output on
 * the target (−14 LUFS for YouTube, −23 for EBU R128, −16 for Apple/podcasts).
 *
 * No I/O here — just the arg vectors and the parse — so it unit-tests without a
 * binary and produces byte-identical commands for the service and the harness.
 */

export interface LoudnormTarget {
	/** Target integrated loudness, LUFS (default −14). */
	targetLufs?: number;
	/** Target maximum true peak, dBFS (default −1). */
	targetTruePeak?: number;
	/** Target loudness range, LU (default 11). */
	targetLra?: number;
}

const DEFAULT_TARGET_LUFS = -14;
const DEFAULT_TARGET_TRUE_PEAK = -1;
const DEFAULT_TARGET_LRA = 11;

/** The shared `loudnorm=I=..:TP=..:LRA=..` prefix both passes use. */
function loudnormBase(target: LoudnormTarget): string {
	const i = target.targetLufs ?? DEFAULT_TARGET_LUFS;
	const tp = target.targetTruePeak ?? DEFAULT_TARGET_TRUE_PEAK;
	const lra = target.targetLra ?? DEFAULT_TARGET_LRA;
	return `loudnorm=I=${i}:TP=${tp}:LRA=${lra}`;
}

/** Pass 1: measure the input and print JSON stats to stderr, decoding to null. */
export function buildLoudnormMeasureArgs({
	inputPath,
	target = {},
}: {
	inputPath: string;
	target?: LoudnormTarget;
}): string[] {
	return [
		"-hide_banner",
		"-i",
		inputPath,
		"-vn",
		"-af",
		`${loudnormBase(target)}:print_format=json`,
		"-f",
		"null",
		"-",
	];
}

/** The measurements pass 1 reports, fed back into pass 2 as `measured_*`. */
export interface LoudnormMeasurement {
	inputI: number;
	inputTp: number;
	inputLra: number;
	inputThresh: number;
	targetOffset: number;
}

interface RawLoudnormStats {
	input_i?: string;
	input_tp?: string;
	input_lra?: string;
	input_thresh?: string;
	target_offset?: string;
}

function requireNumber({
	value,
	label,
}: {
	value: string | undefined;
	label: string;
}): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`loudnorm stats: ${label} missing or non-numeric`);
	}
	return parsed;
}

/**
 * Parse the JSON stats block `loudnorm=print_format=json` prints to stderr. The
 * block is the only brace group carrying `input_i`, so it is matched directly
 * (its values have no nested braces). Throws if the stats are absent — pass 2
 * cannot run without them.
 */
export function parseLoudnormStats({
	stderr,
}: {
	stderr: string;
}): LoudnormMeasurement {
	const match = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
	if (!match) {
		throw new Error("loudnorm stats not found in ffmpeg output");
	}
	const parsed = JSON.parse(match[0]) as RawLoudnormStats;
	return {
		inputI: requireNumber({ value: parsed.input_i, label: "input_i" }),
		inputTp: requireNumber({ value: parsed.input_tp, label: "input_tp" }),
		inputLra: requireNumber({ value: parsed.input_lra, label: "input_lra" }),
		inputThresh: requireNumber({
			value: parsed.input_thresh,
			label: "input_thresh",
		}),
		targetOffset: requireNumber({
			value: parsed.target_offset,
			label: "target_offset",
		}),
	};
}

/**
 * Pass 2: apply the normalisation with the pass-1 measurements and `linear=true`
 * (a single, artefact-free gain toward the target), writing 48 kHz 16-bit PCM.
 */
export function buildLoudnormApplyArgs({
	inputPath,
	outputPath,
	measured,
	target = {},
}: {
	inputPath: string;
	outputPath: string;
	measured: LoudnormMeasurement;
	target?: LoudnormTarget;
}): string[] {
	const filter =
		`${loudnormBase(target)}:measured_I=${measured.inputI}` +
		`:measured_TP=${measured.inputTp}:measured_LRA=${measured.inputLra}` +
		`:measured_thresh=${measured.inputThresh}:offset=${measured.targetOffset}` +
		`:linear=true:print_format=summary`;
	return [
		"-y",
		"-i",
		inputPath,
		"-vn",
		"-af",
		filter,
		"-ar",
		"48000",
		"-c:a",
		"pcm_s16le",
		outputPath,
	];
}
