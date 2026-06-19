import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
type BossSubtitleStyle = {
	color: "white" | "yellow";
	position: "top" | "center" | "bottom";
	fontSize: "sm" | "md" | "lg";
	bold: boolean;
};

const FFMPEG_BASE_URL =
	"https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

type ProgressHandler = (progress: number) => void;

export interface SegmentOutput {
	index: number;
	label: string;
	fileName: string;
	blob: Blob;
	url: string;
	duration: number;
}

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

const clampProgress = (value: number) =>
	Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

const loadWorkerCoreAssets = async () => {
	const [coreURL, wasmURL] = await Promise.all([
		toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
		toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
	]);
	return { coreURL, wasmURL };
};

const getFileExtension = ({
	file,
	fallback,
}: {
	file: File;
	fallback: string;
}) => {
	const match = file.name.match(/\.([a-z0-9]+)$/i);
	return match?.[1]?.toLowerCase() ?? fallback;
};

const readBlobFromFs = async ({
	ffmpeg,
	path,
	type,
}: {
	ffmpeg: FFmpeg;
	path: string;
	type: string;
}) => {
	const fileData = await ffmpeg.readFile(path);
	const bytes =
		typeof fileData === "string"
			? new TextEncoder().encode(fileData)
			: fileData;
	const byteCopy = new Uint8Array(bytes.byteLength);
	byteCopy.set(bytes);
	return new Blob([byteCopy], { type });
};

const runWithProgress = async ({
	ffmpeg,
	progressHandler,
	exec,
}: {
	ffmpeg: FFmpeg;
	progressHandler?: ProgressHandler;
	exec: () => Promise<number>;
}) => {
	const callback = progressHandler
		? ({ progress }: { progress: number }) => {
				progressHandler(clampProgress(progress));
			}
		: null;

	if (callback) {
		ffmpeg.on("progress", callback);
	}

	try {
		const exitCode = await exec();
		if (exitCode !== 0) {
			throw new Error(`FFmpeg exited with code ${exitCode}.`);
		}
	} finally {
		if (callback) {
			ffmpeg.off("progress", callback);
		}
	}
};

export const getBossFfmpeg = async () => {
	if (ffmpegInstance?.loaded) {
		return ffmpegInstance;
	}

	if (!ffmpegLoadPromise) {
		ffmpegLoadPromise = (async () => {
			const ffmpeg = new FFmpeg();
			const { coreURL, wasmURL } = await loadWorkerCoreAssets();

			await ffmpeg.load({ coreURL, wasmURL });
			if (!ffmpeg.loaded) {
				throw new Error("FFmpeg failed to load");
			}
			ffmpegInstance = ffmpeg;
			return ffmpeg;
		})();
	}

	return ffmpegLoadPromise;
};

export const splitVideoAtCues = async ({
	file,
	cues,
	durationSeconds,
	onProgress,
}: {
	file: File;
	cues: number[];
	durationSeconds: number;
	onProgress?: (args: {
		currentIndex: number;
		totalSegments: number;
		segmentLabel: string;
		segmentProgress: number;
		overallProgress: number;
	}) => void;
}) => {
	const ffmpeg = await getBossFfmpeg();
	const jobId = crypto.randomUUID();
	const inputExt = getFileExtension({ file, fallback: "mp4" });
	const inputPath = `${jobId}/source.${inputExt}`;
	const sortedCutPoints = [
		...new Set(cues.map((cue) => Number(cue).toFixed(3))),
	]
		.map((cue) => Number(cue))
		.filter((cue) => cue > 0 && cue < durationSeconds)
		.sort((left, right) => left - right);
	const splitPoints = [0, ...sortedCutPoints, durationSeconds];
	const totalSegments = Math.max(splitPoints.length - 1, 0);

	await ffmpeg.createDir(jobId);
	await ffmpeg.writeFile(inputPath, await fetchFile(file));

	// Phase 7: read source bytes once so each parallel worker can copy them
	// into its own FFmpeg FS without re-encoding or re-fetching.
	const sourceFileData = await ffmpeg.readFile(inputPath);
	if (typeof sourceFileData === "string") {
		throw new Error("FFmpeg returned text data for the source video.");
	}
	const sourceBytes = new Uint8Array(sourceFileData.byteLength);
	sourceBytes.set(sourceFileData);
	let coreURL: string | undefined = undefined;
	let wasmURL: string | undefined = undefined;

	const SPLIT_CONCURRENCY = 3;
	let activeCount = 0;
	const waitQueue: Array<() => void> = [];
	const acquire = () =>
		new Promise<void>((resolve) => {
			if (activeCount < SPLIT_CONCURRENCY) {
				activeCount++;
				resolve();
			} else {
				waitQueue.push(() => {
					activeCount++;
					resolve();
				});
			}
		});
	const release = () => {
		activeCount--;
		waitQueue.shift()?.();
	};

	try {
		({ coreURL, wasmURL } = await loadWorkerCoreAssets());
		const results = await Promise.all(
			Array.from({ length: totalSegments }, (_, index) => index).map(
				async (index) => {
					await acquire();
					const segmentIndex = index + 1;
					const segJobId = crypto.randomUUID();
					const segInputPath = `${segJobId}/source.${inputExt}`;
					const outputPath = `${segJobId}/segment_${String(segmentIndex).padStart(2, "0")}.mp4`;
					let segFfmpeg: FFmpeg | null = null;
					try {
						const startSec = splitPoints[index] ?? 0;
						const endSec = splitPoints[index + 1] ?? durationSeconds;
						const segmentDuration = Math.max(0.1, endSec - startSec);
						const label = `Segment ${String(segmentIndex).padStart(2, "0")}`;
						const fileName = `segment_${String(segmentIndex).padStart(2, "0")}.mp4`;
						segFfmpeg = new FFmpeg();
						await segFfmpeg.load({ coreURL, wasmURL });
						if (!segFfmpeg.loaded) {
							throw new Error(`FFmpeg instance for ${label} failed to load.`);
						}

						await segFfmpeg.createDir(segJobId);
						await segFfmpeg.writeFile(segInputPath, sourceBytes.slice());

						await runWithProgress({
							ffmpeg: segFfmpeg,
							progressHandler: (segmentProgress) =>
								onProgress?.({
									currentIndex: segmentIndex,
									totalSegments,
									segmentLabel: label,
									segmentProgress,
									overallProgress: (index + segmentProgress) / totalSegments,
								}),
							exec: () =>
								segFfmpeg!.exec([
									"-ss",
									startSec.toFixed(3),
									"-i",
									segInputPath,
									"-t",
									segmentDuration.toFixed(3),
									"-c:v",
									"libx264",
									"-preset",
									"ultrafast",
									"-pix_fmt",
									"yuv420p",
									"-c:a",
									"aac",
									"-movflags",
									"+faststart",
									outputPath,
								]),
						});

						const blob = await readBlobFromFs({
							ffmpeg: segFfmpeg,
							path: outputPath,
							type: "video/mp4",
						});

						return {
							index: segmentIndex,
							label,
							fileName,
							blob,
							url: URL.createObjectURL(blob),
							duration: segmentDuration,
						} satisfies SegmentOutput;
					} finally {
						if (segFfmpeg) {
							await segFfmpeg.deleteFile(segInputPath).catch(() => undefined);
							await segFfmpeg.deleteFile(outputPath).catch(() => undefined);
							await segFfmpeg.deleteDir(segJobId).catch(() => undefined);
							segFfmpeg.terminate();
						}
						release();
					}
				},
			),
		);

		// Restore cue order — parallel tasks may complete out of order
		return results.sort((a, b) => a.index - b.index);
	} finally {
		await ffmpeg.deleteFile(inputPath).catch(() => undefined);
		await ffmpeg.deleteDir(jobId).catch(() => undefined);
		if (coreURL) {
			URL.revokeObjectURL(coreURL);
		}
		if (wasmURL) {
			URL.revokeObjectURL(wasmURL);
		}
	}
};

export const createPortraitShort = async ({
	sourceBlob,
	index,
	startSec,
	endSec,
	onProgress,
}: {
	sourceBlob: Blob;
	index: number;
	startSec: number;
	endSec: number;
	onProgress?: ProgressHandler;
}) => {
	const ffmpeg = await getBossFfmpeg();
	const jobId = crypto.randomUUID();
	const inputPath = `${jobId}/segment.mp4`;
	const outputPath = `${jobId}/short_${String(index).padStart(2, "0")}.mp4`;
	const duration = Math.max(1, endSec - startSec);

	await ffmpeg.createDir(jobId);
	await ffmpeg.writeFile(inputPath, await fetchFile(sourceBlob));

	try {
		await runWithProgress({
			ffmpeg,
			progressHandler: onProgress,
			exec: () =>
				ffmpeg.exec([
					"-ss",
					startSec.toFixed(3),
					"-i",
					inputPath,
					"-t",
					duration.toFixed(3),
					"-vf",
					"scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-movflags",
					"+faststart",
					outputPath,
				]),
		});

		return await readBlobFromFs({
			ffmpeg,
			path: outputPath,
			type: "video/mp4",
		});
	} finally {
		await ffmpeg.deleteFile(inputPath);
		await ffmpeg.deleteFile(outputPath).catch(() => undefined);
		await ffmpeg.deleteDir(jobId);
	}
};

const subtitleColorMap: Record<BossSubtitleStyle["color"], string> = {
	white: "&HFFFFFF",
	yellow: "&H00FFFF",
};

const subtitleAlignmentMap: Record<BossSubtitleStyle["position"], number> = {
	bottom: 2,
	center: 5,
	top: 8,
};

const subtitleFontSizeMap: Record<
	BossSubtitleStyle["fontSize"],
	{ segment: number; short: number }
> = {
	sm: { segment: 20, short: 28 },
	md: { segment: 24, short: 32 },
	lg: { segment: 28, short: 36 },
};

export const burnSubtitlesIntoVideo = async ({
	sourceBlob,
	srt,
	style,
	kind,
	onProgress,
}: {
	sourceBlob: Blob;
	srt: string;
	style: BossSubtitleStyle;
	kind: "segment" | "short";
	onProgress?: ProgressHandler;
}) => {
	const ffmpeg = await getBossFfmpeg();
	const jobId = crypto.randomUUID();
	const inputPath = `${jobId}/input.mp4`;
	const subtitlePath = `${jobId}/subtitles.srt`;
	const outputPath = `${jobId}/output.mp4`;
	const fontSize = subtitleFontSizeMap[style.fontSize][kind];
	// Shorts honor the same explicit subtitle position mapping as segments.
	// ASS alignment 2 is already the correct bottom-center value.
	const alignment = subtitleAlignmentMap[style.position];
	const forceStyle = [
		`FontSize=${fontSize}`,
		`PrimaryColour=${subtitleColorMap[style.color]}`,
		`Alignment=${alignment}`,
		`Bold=${style.bold ? 1 : 0}`,
	].join(",");

	await ffmpeg.createDir(jobId);
	await ffmpeg.writeFile(inputPath, await fetchFile(sourceBlob));
	await ffmpeg.writeFile(subtitlePath, srt);

	try {
		await runWithProgress({
			ffmpeg,
			progressHandler: onProgress,
			exec: () =>
				ffmpeg.exec([
					"-i",
					inputPath,
					"-vf",
					`subtitles=${subtitlePath}:force_style='${forceStyle}'`,
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-movflags",
					"+faststart",
					outputPath,
				]),
		});

		return await readBlobFromFs({
			ffmpeg,
			path: outputPath,
			type: "video/mp4",
		});
	} finally {
		await ffmpeg.deleteFile(inputPath);
		await ffmpeg.deleteFile(subtitlePath);
		await ffmpeg.deleteFile(outputPath).catch(() => undefined);
		await ffmpeg.deleteDir(jobId);
	}
};

export const createVideoThumbnail = async ({
	url,
	seekSeconds = 0.1,
}: {
	url: string;
	seekSeconds?: number;
}) =>
	new Promise<string>((resolve, reject) => {
		const video = document.createElement("video");
		const timeoutId = window.setTimeout(() => {
			cleanup();
			reject(new Error("Timed out while generating the video thumbnail."));
		}, 5000);
		video.preload = "metadata";
		video.playsInline = true;
		video.muted = true;
		video.src = url;

		const cleanup = () => {
			window.clearTimeout(timeoutId);
			video.pause();
			video.removeAttribute("src");
			video.load();
		};

		video.onloadedmetadata = () => {
			video.currentTime = Math.min(
				seekSeconds,
				Math.max(video.duration - 0.1, 0),
			);
		};

		video.onseeked = () => {
			const canvas = document.createElement("canvas");
			canvas.width = video.videoWidth || 320;
			canvas.height = video.videoHeight || 180;
			const context = canvas.getContext("2d");

			if (!context) {
				cleanup();
				reject(new Error("Could not create a thumbnail canvas context."));
				return;
			}

			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			canvas.toBlob(
				(blob) => {
					cleanup();
					if (!blob) {
						reject(new Error("Could not generate a thumbnail image."));
						return;
					}

					resolve(URL.createObjectURL(blob));
				},
				"image/jpeg",
				0.85,
			);
		};

		video.onerror = () => {
			cleanup();
			reject(new Error("Could not load the video for thumbnail generation."));
		};
	});
