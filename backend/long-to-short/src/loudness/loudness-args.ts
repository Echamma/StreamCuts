/**
 * Pure ffmpeg argument builder + output parser for EBU R128 loudness
 * measurement (FAIR-008). ffmpeg's `ebur128` filter prints a `Summary:` block to
 * stderr with the integrated loudness (LUFS), loudness range (LU) and true peak
 * (dBFS) — the numbers delivery targets are set against (YouTube ≈ −14, EBU R128
 * = −23). {@link parseEbur128Summary} reduces that block to a typed summary. No
 * I/O here, so it unit-tests without a binary.
 */

export interface LoudnessArgsOptions {
	inputPath: string;
}

/**
 * ffmpeg args that analyse loudness and decode nothing to disk (`-f null -`).
 * Video is skipped (`-vn`) for speed; `peak=true` enables true-peak reporting.
 */
export function buildLoudnessArgs({ inputPath }: LoudnessArgsOptions): string[] {
	return [
		"-hide_banner",
		"-i",
		inputPath,
		"-vn",
		"-af",
		"ebur128=peak=true",
		"-f",
		"null",
		"-",
	];
}

export interface LoudnessSummary {
	/** Integrated (program) loudness, LUFS. */
	integratedLufs: number | null;
	/** Loudness range, LU. */
	loudnessRangeLu: number | null;
	/** True peak, dBFS. */
	truePeakDbfs: number | null;
	/** Relative gating threshold for the integrated measure, LUFS. */
	thresholdLufs: number | null;
}

function matchNumber({
	text,
	pattern,
}: {
	text: string;
	pattern: RegExp;
}): number | null {
	const match = text.match(pattern);
	if (!match) {
		return null;
	}
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

/**
 * Parse the `ebur128` `Summary:` block from ffmpeg stderr. Only the summary is
 * read (the per-frame log lines carry the same labels), so parsing is anchored
 * to the last `Summary:`. Missing fields come back `null` rather than throwing.
 */
export function parseEbur128Summary({
	stderr,
}: {
	stderr: string;
}): LoudnessSummary {
	const summaryIndex = stderr.lastIndexOf("Summary:");
	const block = summaryIndex >= 0 ? stderr.slice(summaryIndex) : stderr;
	return {
		integratedLufs: matchNumber({
			text: block,
			pattern: /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/,
		}),
		// "LU" (not "LUFS") distinguishes the range line from the "LRA low/high"
		// LUFS lines; the `LRA:` colon excludes "LRA low:"/"LRA high:".
		loudnessRangeLu: matchNumber({
			text: block,
			pattern: /\bLRA:\s*(-?\d+(?:\.\d+)?)\s*LU(?!FS)/,
		}),
		truePeakDbfs: matchNumber({
			text: block,
			pattern: /\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/,
		}),
		thresholdLufs: matchNumber({
			text: block,
			pattern: /\bThreshold:\s*(-?\d+(?:\.\d+)?)\s*LUFS/,
		}),
	};
}
