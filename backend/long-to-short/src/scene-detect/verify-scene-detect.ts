import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { detectScenes } from "./scene-detect-runner";

/**
 * End-to-end verification for scene detection. Synthesises a clip with three
 * visually distinct 1s segments (bars → red → blue) so cuts fall at ~1s and
 * ~2s, then asserts the detector finds them. Uses the system ffmpeg on PATH.
 *
 * Run:  node --experimental-strip-types src/scene-detect/verify-scene-detect.ts
 */

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
	if (!condition) failures += 1;
	console.log(`  [${condition ? "PASS" : "FAIL"}] ${label} — ${detail}`);
}

function hasCutNear(cuts: number[], target: number, tolerance: number): boolean {
	return cuts.some((cut) => Math.abs(cut - target) <= tolerance);
}

async function main(): Promise<void> {
	const workDir = await mkdtemp(join(tmpdir(), "scene-verify-"));
	const source = join(workDir, "scenes.mp4");

	try {
		console.log("Generating a 3-scene clip (bars → red → blue, 1s each)…");
		await execFileAsync(
			FFMPEG,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc=size=640x480:rate=30:duration=1",
				"-f",
				"lavfi",
				"-i",
				"color=c=red:size=640x480:rate=30:duration=1",
				"-f",
				"lavfi",
				"-i",
				"color=c=blue:size=640x480:rate=30:duration=1",
				"-filter_complex",
				"[0:v][1:v][2:v]concat=n=3:v=1[out]",
				"-map",
				"[out]",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				source,
			],
			{ maxBuffer: 1024 * 1024 * 64 },
		);

		console.log("\nMED-008 — scene detection:");
		const { cuts } = await detectScenes({
			ffmpegPath: FFMPEG,
			inputPath: source,
			threshold: 0.3,
		});
		console.log(`  detected cuts: [${cuts.map((c) => c.toFixed(3)).join(", ")}]`);

		check("found a cut near 1s (bars→red)", hasCutNear(cuts, 1, 0.25), `cuts=${cuts.length}`);
		check("found a cut near 2s (red→blue)", hasCutNear(cuts, 2, 0.25), `cuts=${cuts.length}`);
		check(
			"no spurious cut at time 0",
			!cuts.some((cut) => cut < 0.1),
			"first frame excluded",
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
