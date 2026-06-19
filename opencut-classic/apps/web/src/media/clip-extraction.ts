import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { clampRetimeRate } from "@/retime/rate";

const FFMPEG_BASE_URL =
	"https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

const loadWorkerCoreAssets = async () => {
	const [coreURL, wasmURL] = await Promise.all([
		toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
		toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
	]);

	return { coreURL, wasmURL };
};

const getClipFfmpeg = async () => {
	if (ffmpegInstance?.loaded) {
		return ffmpegInstance;
	}

	if (!ffmpegLoadPromise) {
		ffmpegLoadPromise = (async () => {
			const ffmpeg = new FFmpeg();
			const { coreURL, wasmURL } = await loadWorkerCoreAssets();

			await ffmpeg.load({ coreURL, wasmURL });
			if (!ffmpeg.loaded) {
				throw new Error("FFmpeg failed to load.");
			}

			ffmpegInstance = ffmpeg;
			return ffmpeg;
		})();
	}

	return ffmpegLoadPromise;
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

const sanitizeFileStem = (value: string) =>
	value
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[<>:"/\\|?*]+/g, "-")
		.split("")
		.map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
		.join("")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase() || "clip";

const formatFileTimestamp = (seconds: number) => {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const remainingSeconds = total % 60;

	return [hours, minutes, remainingSeconds]
		.map((value) => String(value).padStart(2, "0"))
		.join("-");
};

const buildAtempoFilter = (rate: number) => {
	const filters: string[] = [];
	let remaining = clampRetimeRate({ rate });

	while (remaining > 2) {
		filters.push("atempo=2");
		remaining /= 2;
	}

	while (remaining < 0.5) {
		filters.push("atempo=0.5");
		remaining /= 0.5;
	}

	filters.push(`atempo=${remaining.toFixed(5)}`);
	return filters.join(",");
};

export const extractMediaClip = async ({
	file,
	kind,
	startSeconds,
	durationSeconds,
	baseName,
	retimeRate,
	includeAudio,
}: {
	file: File;
	kind: "video" | "audio";
	startSeconds: number;
	durationSeconds: number;
	baseName: string;
	retimeRate?: number;
	includeAudio?: boolean;
}) => {
	const ffmpeg = await getClipFfmpeg();
	const jobId = crypto.randomUUID();
	const inputExt = getFileExtension({
		file,
		fallback: kind === "video" ? "mp4" : "m4a",
	});
	const inputPath = `${jobId}/source.${inputExt}`;
	const outputExt = kind === "video" ? "mp4" : "m4a";
	const outputMimeType = kind === "video" ? "video/mp4" : "audio/mp4";
	const outputPath = `${jobId}/clip.${outputExt}`;
	const safeStartSeconds = Math.max(0, startSeconds);
	const safeDurationSeconds = Math.max(0.1, durationSeconds);
	const effectiveRate =
		retimeRate != null ? clampRetimeRate({ rate: retimeRate }) : 1;
	const shouldRetime = Math.abs(effectiveRate - 1) > 1e-6;

	await ffmpeg.createDir(jobId);
	await ffmpeg.writeFile(inputPath, await fetchFile(file));

	try {
		const args = [
			"-ss",
			safeStartSeconds.toFixed(3),
			"-i",
			inputPath,
			"-t",
			safeDurationSeconds.toFixed(3),
		];

		if (kind === "video") {
			args.push("-map", "0:v:0", "-map", "0:a?");

			if (shouldRetime) {
				args.push("-vf", `setpts=PTS/${effectiveRate.toFixed(5)}`);
				if (includeAudio) {
					args.push("-af", buildAtempoFilter(effectiveRate));
				}
			}

			args.push(
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
			);
		} else {
			args.push("-vn");
			if (shouldRetime) {
				args.push("-af", buildAtempoFilter(effectiveRate));
			}
			args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
		}

		args.push(outputPath);

		const exitCode = await ffmpeg.exec(args);
		if (exitCode !== 0) {
			throw new Error(`FFmpeg exited with code ${exitCode}.`);
		}

		const blob = await readBlobFromFs({
			ffmpeg,
			path: outputPath,
			type: outputMimeType,
		});

		const clipName = `${sanitizeFileStem(baseName)}-${formatFileTimestamp(
			safeStartSeconds,
		)}-${formatFileTimestamp(safeStartSeconds + safeDurationSeconds)}.${outputExt}`;

		return new File([blob], clipName, {
			type: outputMimeType,
			lastModified: Date.now(),
		});
	} finally {
		await ffmpeg.deleteFile(inputPath).catch(() => undefined);
		await ffmpeg.deleteFile(outputPath).catch(() => undefined);
		await ffmpeg.deleteDir(jobId).catch(() => undefined);
	}
};
