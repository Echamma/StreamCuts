/**
 * Pure ffmpeg argument builder + output parser for scene-cut detection
 * (MED-008). ffmpeg's `select='gt(scene,T)'` passes only frames whose
 * scene-change score exceeds the threshold; `showinfo` then logs each such
 * frame's timestamp to stderr, which {@link parseSceneTimestamps} reduces to a
 * cut list. No I/O here, so it unit-tests without a binary.
 */

export const DEFAULT_SCENE_THRESHOLD = 0.4;

export interface SceneDetectArgsOptions {
	inputPath: string;
	/** Scene-change score in (0, 1]; higher = fewer, stronger cuts. */
	threshold?: number;
}

/**
 * ffmpeg args that log a `showinfo` line per detected scene-change frame to
 * stderr, decoding nothing to disk (`-f null -`). Audio is dropped for speed.
 */
export function buildSceneDetectArgs({
	inputPath,
	threshold = DEFAULT_SCENE_THRESHOLD,
}: SceneDetectArgsOptions): string[] {
	return [
		"-hide_banner",
		"-i",
		inputPath,
		"-filter:v",
		`select='gt(scene,${threshold})',showinfo`,
		"-an",
		"-f",
		"null",
		"-",
	];
}

const PTS_TIME_PATTERN = /pts_time:(\d+(?:\.\d+)?)/g;

/**
 * Extract cut timestamps (seconds) from ffmpeg `showinfo` stderr, sorted
 * ascending and de-duplicated. A frame at time 0 is dropped — the first frame
 * has no predecessor to differ from, so it is never a real cut.
 */
export function parseSceneTimestamps({ stderr }: { stderr: string }): number[] {
	const seconds = new Set<number>();
	for (const match of stderr.matchAll(PTS_TIME_PATTERN)) {
		const value = Number(match[1]);
		if (Number.isFinite(value) && value > 0) {
			seconds.add(value);
		}
	}
	return [...seconds].sort((a, b) => a - b);
}
