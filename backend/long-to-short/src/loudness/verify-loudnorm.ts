import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { measureLoudness, normalizeLoudness } from "./loudness-runner";

/**
 * Closed-loop verification for loudness normalisation. Synthesises a quiet tone,
 * normalises it toward a target with the real two-pass runner, then RE-MEASURES
 * the output with the ebur128 core (`measureLoudness`) and asserts it landed on
 * the target. Objective, non-perceptual proof the whole loop is correct. Uses
 * the system `ffmpeg` on PATH.
 *
 * Run:  node --experimental-strip-types src/loudness/verify-loudnorm.ts
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

async function main(): Promise<void> {
	const workDir = await mkdtemp(join(tmpdir(), "loudnorm-verify-"));
	const quiet = join(workDir, "quiet.wav");
	const normalized = join(workDir, "normalized.wav");
	const targetLufs = -14;

	try {
		console.log("Synthesising a quiet (−20 dB) 1 kHz tone…");
		await execFileAsync(
			FFMPEG,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=1000:duration=6",
				"-af",
				"volume=0.1",
				"-c:a",
				"pcm_s16le",
				quiet,
			],
			{ maxBuffer: MAX_BUFFER },
		);

		const before = await measureLoudness({ ffmpegPath: FFMPEG, inputPath: quiet });
		console.log(`  before: I=${before.integratedLufs} LUFS`);

		console.log(`\nFAIR-008 — normalise to ${targetLufs} LUFS (two-pass):`);
		const { measured } = await normalizeLoudness({
			ffmpegPath: FFMPEG,
			inputPath: quiet,
			outputPath: normalized,
			target: { targetLufs },
		});
		const after = await measureLoudness({
			ffmpegPath: FFMPEG,
			inputPath: normalized,
		});
		console.log(
			`  measured input I=${measured.inputI} LUFS → after: I=${after.integratedLufs} LUFS  TPK=${after.truePeakDbfs} dBFS`,
		);

		check(
			"pass-1 measured the quiet input near −41 LUFS",
			Math.abs(measured.inputI - (before.integratedLufs ?? 0)) <= 1,
			`measured ${measured.inputI} vs ebur128 ${before.integratedLufs}`,
		);
		check(
			"output lands on target (re-measured)",
			after.integratedLufs !== null &&
				Math.abs(after.integratedLufs - targetLufs) <= 1,
			`got ${after.integratedLufs} LUFS (target ${targetLufs})`,
		);
		check(
			"output was made louder",
			after.integratedLufs !== null &&
				before.integratedLufs !== null &&
				after.integratedLufs > before.integratedLufs,
			`${before.integratedLufs} → ${after.integratedLufs} LUFS`,
		);
		check(
			"true peak stays under the −1 dBFS ceiling (+0.5 tol)",
			after.truePeakDbfs !== null && after.truePeakDbfs <= -1 + 0.5,
			`got ${after.truePeakDbfs} dBFS`,
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
