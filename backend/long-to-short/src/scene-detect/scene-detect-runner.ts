import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildSceneDetectArgs,
	parseSceneTimestamps,
	type SceneDetectArgsOptions,
} from "./scene-detect-args";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 64;

/**
 * Detect scene cuts in a media file (MED-008). The ffmpeg binary path is passed
 * in (the NestJS service resolves `ffmpeg-static`; the verification harness
 * passes the system binary), so this has no external dependency. Returns cut
 * timestamps in seconds.
 */
export async function detectScenes({
	ffmpegPath,
	inputPath,
	threshold,
}: {
	ffmpegPath: string;
} & SceneDetectArgsOptions): Promise<{ cuts: number[] }> {
	// showinfo/select log to stderr; the null muxer produces no stdout.
	const { stderr } = await execFileAsync(
		ffmpegPath,
		buildSceneDetectArgs({ inputPath, threshold }),
		{ encoding: "utf8", maxBuffer: MAX_BUFFER },
	);
	return { cuts: parseSceneTimestamps({ stderr }) };
}
