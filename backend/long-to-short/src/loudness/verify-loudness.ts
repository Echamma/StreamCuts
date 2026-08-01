import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { measureLoudness } from "./loudness-runner";

/**
 * End-to-end verification for the loudness core. Synthesises two tones at known
 * relative levels with ffmpeg, measures each through the real runner, and
 * asserts the numbers move the right way (a −20 dB gain drops the integrated
 * loudness by ≈20 LUFS). Objective, non-perceptual proof the ebur128 parse is
 * correct. Uses the system `ffmpeg` on PATH.
 *
 * Run:  node --experimental-strip-types src/loudness/verify-loudness.ts
 */

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const MAX_BUFFER = 1024 * 1024 * 64;

let failures = 0;

function check(label: string, condition: boolean, detail: string): void {
	const status = condition ? "PASS" : "FAIL";
	if (!condition) failures += 1;
	console.log(`  [${status}] ${label} — ${detail}`);
}

function near(actual: number, expected: number, tolerance: number): boolean {
	return Math.abs(actual - expected) <= tolerance;
}

async function synthTone({
	outPath,
	volume,
}: {
	outPath: string;
	volume: number;
}): Promise<void> {
	await execFileAsync(
		FFMPEG,
		[
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=1000:duration=4",
			"-af",
			`volume=${volume}`,
			"-c:a",
			"pcm_s16le",
			outPath,
		],
		{ maxBuffer: MAX_BUFFER },
	);
}

async function main(): Promise<void> {
	const workDir = await mkdtemp(join(tmpdir(), "loudness-verify-"));
	const loudPath = join(workDir, "loud.wav");
	const quietPath = join(workDir, "quiet.wav");

	try {
		console.log("Synthesising a loud (0 dB) and quiet (−20 dB) 1 kHz tone…");
		await synthTone({ outPath: loudPath, volume: 1 });
		await synthTone({ outPath: quietPath, volume: 0.1 });

		console.log("\nFAIR-008 — EBU R128 loudness measurement:");
		const loud = await measureLoudness({ ffmpegPath: FFMPEG, inputPath: loudPath });
		const quiet = await measureLoudness({ ffmpegPath: FFMPEG, inputPath: quietPath });
		console.log(
			`  loud:  I=${loud.integratedLufs} LUFS  LRA=${loud.loudnessRangeLu} LU  TPK=${loud.truePeakDbfs} dBFS`,
		);
		console.log(
			`  quiet: I=${quiet.integratedLufs} LUFS  LRA=${quiet.loudnessRangeLu} LU  TPK=${quiet.truePeakDbfs} dBFS`,
		);

		check(
			"loud integrated loudness parsed",
			loud.integratedLufs !== null,
			`got ${loud.integratedLufs}`,
		);
		check(
			"quiet integrated loudness parsed",
			quiet.integratedLufs !== null,
			`got ${quiet.integratedLufs}`,
		);
		check(
			"louder tone reads higher LUFS",
			loud.integratedLufs !== null &&
				quiet.integratedLufs !== null &&
				loud.integratedLufs > quiet.integratedLufs,
			`${loud.integratedLufs} > ${quiet.integratedLufs}`,
		);
		check(
			"−20 dB gain ≈ −20 LUFS",
			loud.integratedLufs !== null &&
				quiet.integratedLufs !== null &&
				near(loud.integratedLufs - quiet.integratedLufs, 20, 2),
			`Δ = ${
				loud.integratedLufs !== null && quiet.integratedLufs !== null
					? (loud.integratedLufs - quiet.integratedLufs).toFixed(1)
					: "n/a"
			} LU`,
		);
		check(
			"true peak parsed and louder is higher",
			loud.truePeakDbfs !== null &&
				quiet.truePeakDbfs !== null &&
				loud.truePeakDbfs > quiet.truePeakDbfs,
			`${loud.truePeakDbfs} > ${quiet.truePeakDbfs} dBFS`,
		);
		check(
			"loudness range parsed",
			loud.loudnessRangeLu !== null,
			`got ${loud.loudnessRangeLu}`,
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}

	console.log(
		`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
	);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
