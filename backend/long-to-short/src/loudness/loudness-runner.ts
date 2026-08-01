import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildLoudnessArgs,
	parseEbur128Summary,
	type LoudnessSummary,
} from "./loudness-args";
import {
	buildLoudnormApplyArgs,
	buildLoudnormMeasureArgs,
	parseLoudnormStats,
	type LoudnormMeasurement,
	type LoudnormTarget,
} from "./loudnorm-args";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 64;

/**
 * Measure EBU R128 loudness of a media file (FAIR-008). The ffmpeg binary path
 * is passed in (the NestJS service resolves `ffmpeg-static`; the verification
 * harness passes the system binary), so this has no external dependency. Returns
 * the integrated loudness, range and true peak.
 */
export async function measureLoudness({
	ffmpegPath,
	inputPath,
}: {
	ffmpegPath: string;
	inputPath: string;
}): Promise<LoudnessSummary> {
	// ebur128 logs its Summary to stderr; the null muxer produces no stdout.
	const { stderr } = await execFileAsync(
		ffmpegPath,
		buildLoudnessArgs({ inputPath }),
		{ encoding: "utf8", maxBuffer: MAX_BUFFER },
	);
	return parseEbur128Summary({ stderr });
}

/**
 * Two-pass loudness normalisation (FAIR-008). Pass 1 measures the input, pass 2
 * applies a linear gain toward the target, writing `outputPath`. Returns the
 * pass-1 measurements. The ffmpeg binary path is injected, so this has no
 * external dependency.
 */
export async function normalizeLoudness({
	ffmpegPath,
	inputPath,
	outputPath,
	target,
}: {
	ffmpegPath: string;
	inputPath: string;
	outputPath: string;
	target?: LoudnormTarget;
}): Promise<{ measured: LoudnormMeasurement }> {
	const { stderr } = await execFileAsync(
		ffmpegPath,
		buildLoudnormMeasureArgs({ inputPath, target }),
		{ encoding: "utf8", maxBuffer: MAX_BUFFER },
	);
	const measured = parseLoudnormStats({ stderr });

	await execFileAsync(
		ffmpegPath,
		buildLoudnormApplyArgs({ inputPath, outputPath, measured, target }),
		{ encoding: "utf8", maxBuffer: MAX_BUFFER },
	);
	return { measured };
}
