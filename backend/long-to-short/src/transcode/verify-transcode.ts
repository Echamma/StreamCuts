import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	probeMedia,
	transcodeToAudio,
	transcodeToOptimized,
	transcodeToProRes,
	transcodeToProxy,
} from "./transcode-runner";

/**
 * End-to-end verification for the transcode core. Synthesises a test clip with
 * ffmpeg, runs it through the real proxy/ProRes builders, and asserts the
 * output with ffprobe — objective, non-perceptual proof that the codecs and
 * scaling come out right. Uses the system `ffmpeg`/`ffprobe` on PATH so it runs
 * without installing the backend's bundled binaries.
 *
 * Run:  node --experimental-strip-types src/transcode/verify-transcode.ts
 */

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

let failures = 0;

function check(label: string, condition: boolean, detail: string): void {
	const status = condition ? "PASS" : "FAIL";
	if (!condition) failures += 1;
	console.log(`  [${status}] ${label} — ${detail}`);
}

function near(actual: number | null, expected: number, tolerance: number): boolean {
	return actual !== null && Math.abs(actual - expected) <= tolerance;
}

async function main(): Promise<void> {
	const workDir = await mkdtemp(join(tmpdir(), "transcode-verify-"));
	const source = join(workDir, "source.mp4");
	const proxy = join(workDir, "proxy.mp4");
	const master = join(workDir, "master.mov");
	const optimized = join(workDir, "optimized.mp4");
	const audioMp3 = join(workDir, "audio.mp3");
	const audioWav = join(workDir, "audio.wav");

	try {
		console.log("Generating a 2s 1280x720 test clip with tone…");
		await execFileAsync(
			FFMPEG,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc=duration=2:size=1280x720:rate=30",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=2",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-shortest",
				source,
			],
			{ maxBuffer: 1024 * 1024 * 64 },
		);

		console.log("\nMED-005 — 540p H.264 proxy:");
		await transcodeToProxy({
			ffmpegPath: FFMPEG,
			options: { inputPath: source, outputPath: proxy, height: 540 },
		});
		const proxyInfo = await probeMedia({ ffprobePath: FFPROBE, filePath: proxy });
		check("codec is H.264", proxyInfo.videoCodec === "h264", `got ${proxyInfo.videoCodec}`);
		check("scaled to 540p", proxyInfo.height === 540, `got ${proxyInfo.height}`);
		check(
			"aspect preserved (960x540)",
			proxyInfo.width === 960,
			`got ${proxyInfo.width}`,
		);
		check("audio carried (aac)", proxyInfo.audioCodec === "aac", `got ${proxyInfo.audioCodec}`);
		check("duration ~2s", near(proxyInfo.durationSeconds, 2, 0.2), `got ${proxyInfo.durationSeconds}`);

		console.log("\nDEL-003 — ProRes (standard) master:");
		await transcodeToProRes({
			ffmpegPath: FFMPEG,
			inputPath: source,
			outputPath: master,
			profile: "standard",
		});
		const masterInfo = await probeMedia({ ffprobePath: FFPROBE, filePath: master });
		check("codec is ProRes", masterInfo.videoCodec === "prores", `got ${masterInfo.videoCodec}`);
		check(
			"full resolution kept (1280x720)",
			masterInfo.width === 1280 && masterInfo.height === 720,
			`got ${masterInfo.width}x${masterInfo.height}`,
		);
		check(
			"audio is PCM",
			masterInfo.audioCodec === "pcm_s16le",
			`got ${masterInfo.audioCodec}`,
		);
		check("duration ~2s", near(masterInfo.durationSeconds, 2, 0.2), `got ${masterInfo.durationSeconds}`);

		console.log("\nMED-006 — optimized (all-intra H.264) media:");
		await transcodeToOptimized({
			ffmpegPath: FFMPEG,
			options: { inputPath: source, outputPath: optimized },
		});
		const optimizedInfo = await probeMedia({
			ffprobePath: FFPROBE,
			filePath: optimized,
		});
		check("codec is H.264", optimizedInfo.videoCodec === "h264", `got ${optimizedInfo.videoCodec}`);
		check(
			"source resolution kept (1280x720)",
			optimizedInfo.width === 1280 && optimizedInfo.height === 720,
			`got ${optimizedInfo.width}x${optimizedInfo.height}`,
		);
		// All-intra: every frame is a keyframe (no inter frames).
		const { stdout: frameTypes } = await execFileAsync(
			FFPROBE,
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"frame=pict_type",
				"-of",
				"csv=p=0",
				optimized,
			],
			{ maxBuffer: 1024 * 1024 * 64 },
		);
		// ffprobe's csv output can leave a trailing comma, so split on commas too.
		const types = frameTypes
			.split(/[\r\n,]+/)
			.map((token) => token.trim())
			.filter((token) => token !== "");
		check(
			"every frame is intra (all-I)",
			types.length > 0 && types.every((type) => type === "I"),
			`${types.filter((t) => t === "I").length}/${types.length} I-frames`,
		);

		console.log("\nDEL-007 — audio-only export (MP3 + WAV):");
		await transcodeToAudio({
			ffmpegPath: FFMPEG,
			options: { inputPath: source, outputPath: audioMp3, format: "mp3" },
		});
		const mp3Info = await probeMedia({ ffprobePath: FFPROBE, filePath: audioMp3 });
		check("MP3: video dropped", mp3Info.videoCodec === null, `got ${mp3Info.videoCodec}`);
		check("MP3: audio is mp3", mp3Info.audioCodec === "mp3", `got ${mp3Info.audioCodec}`);
		check("MP3: duration ~2s", near(mp3Info.durationSeconds, 2, 0.2), `got ${mp3Info.durationSeconds}`);

		await transcodeToAudio({
			ffmpegPath: FFMPEG,
			options: { inputPath: source, outputPath: audioWav, format: "wav" },
		});
		const wavInfo = await probeMedia({ ffprobePath: FFPROBE, filePath: audioWav });
		check("WAV: video dropped", wavInfo.videoCodec === null, `got ${wavInfo.videoCodec}`);
		check(
			"WAV: audio is PCM",
			wavInfo.audioCodec === "pcm_s16le",
			`got ${wavInfo.audioCodec}`,
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
