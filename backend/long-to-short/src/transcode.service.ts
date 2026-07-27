import {
	BadRequestException,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
} from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "ffprobe-static";
import { createReadStream, existsSync, mkdirSync, type ReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	probeMedia,
	transcodeToProRes,
	transcodeToProxy,
} from "./transcode/transcode-runner";
import type {
	ProbeSummary,
	ProResProfile,
} from "./transcode/transcode-args";

const BASE_DIR = join(tmpdir(), "streamcuts-transcode");
const UPLOADS_DIR = join(BASE_DIR, "uploads");
const OUTPUTS_DIR = join(BASE_DIR, "outputs");

const PRORES_PROFILE_NAMES = new Set<string>([
	"proxy",
	"lt",
	"standard",
	"hq",
	"4444",
	"4444xq",
]);

function isProResProfile(value: string): value is ProResProfile {
	return PRORES_PROFILE_NAMES.has(value);
}

/** Upload directory for transcode sources, created on demand. Exported so the
 * controller's multer `diskStorage` can target it without a service instance
 * (mirrors long-to-short's `getUploadDirectory`). */
export function getTranscodeUploadDirectory(): string {
	mkdirSync(UPLOADS_DIR, { recursive: true });
	return UPLOADS_DIR;
}

export interface TranscodeResult {
	id: string;
	fileName: string;
	video: ProbeSummary;
}

/**
 * NestJS service wrapping the pure transcode core (`./transcode`). Resolves the
 * bundled `ffmpeg-static`/`ffprobe-static` binaries, transcodes an uploaded file
 * to a ProRes master (DEL-003) or H.264 proxy (MED-005), and probes the result.
 */
@Injectable()
export class TranscodeService {
	constructor() {
		mkdirSync(UPLOADS_DIR, { recursive: true });
		mkdirSync(OUTPUTS_DIR, { recursive: true });
	}

	private resolveBinaries(): { ffmpegPath: string; ffprobePath: string } {
		// `FFMPEG_PATH`/`FFPROBE_PATH` override the bundled binaries — useful when
		// the host has a fuller ffmpeg build, or when the packaged one is
		// unavailable. Falls back to `ffmpeg-static`/`ffprobe-static`.
		const ffmpeg = process.env.FFMPEG_PATH ?? ffmpegPath;
		const ffprobe = process.env.FFPROBE_PATH ?? ffprobePath;
		if (!ffmpeg || !ffprobe) {
			throw new InternalServerErrorException(
				"No ffmpeg/ffprobe binary available. Set FFMPEG_PATH/FFPROBE_PATH or reinstall backend dependencies.",
			);
		}
		return { ffmpegPath: ffmpeg, ffprobePath: ffprobe };
	}

	async createProxy({
		file,
		height,
	}: {
		file: Express.Multer.File;
		height?: number;
	}): Promise<TranscodeResult> {
		return this.run({
			file,
			extension: ".mp4",
			transcode: ({ ffmpegBinary, inputPath, outputPath }) =>
				transcodeToProxy({
					ffmpegPath: ffmpegBinary,
					options: { inputPath, outputPath, height },
				}),
		});
	}

	async createProRes({
		file,
		profile,
	}: {
		file: Express.Multer.File;
		profile?: string;
	}): Promise<TranscodeResult> {
		if (profile !== undefined && !isProResProfile(profile)) {
			throw new BadRequestException(`Unknown ProRes profile: ${profile}`);
		}
		return this.run({
			file,
			extension: ".mov",
			transcode: ({ ffmpegBinary, inputPath, outputPath }) =>
				transcodeToProRes({
					ffmpegPath: ffmpegBinary,
					inputPath,
					outputPath,
					profile,
				}),
		});
	}

	private async run({
		file,
		extension,
		transcode,
	}: {
		file: Express.Multer.File | undefined;
		extension: string;
		transcode: (args: {
			ffmpegBinary: string;
			inputPath: string;
			outputPath: string;
		}) => Promise<void>;
	}): Promise<TranscodeResult> {
		if (!file) {
			throw new BadRequestException("No video uploaded.");
		}
		const { ffmpegPath: ffmpegBinary, ffprobePath: ffprobeBinary } =
			this.resolveBinaries();

		const id = randomUUID();
		const fileName = `${id}${extension}`;
		const outputPath = join(OUTPUTS_DIR, fileName);

		try {
			await transcode({ ffmpegBinary, inputPath: file.path, outputPath });
		} catch {
			throw new BadRequestException(
				"Transcode failed. The uploaded file may not be a supported video.",
			);
		}

		const video = await probeMedia({
			ffprobePath: ffprobeBinary,
			filePath: outputPath,
		});
		return { id, fileName, video };
	}

	getOutputPath(fileName: string): string {
		if (basename(fileName) !== fileName) {
			throw new BadRequestException("Invalid file name.");
		}
		const outputPath = join(OUTPUTS_DIR, fileName);
		if (!existsSync(outputPath)) {
			throw new NotFoundException("Transcode output not found.");
		}
		return outputPath;
	}

	getOutputReadStream(fileName: string): ReadStream {
		return createReadStream(this.getOutputPath(fileName));
	}
}
