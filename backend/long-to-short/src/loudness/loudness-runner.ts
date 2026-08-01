import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildLoudnessArgs,
	parseEbur128Summary,
	type LoudnessSummary,
} from "./loudness-args";

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
