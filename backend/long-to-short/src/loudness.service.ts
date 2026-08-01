import {
	BadRequestException,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
} from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	type ReadStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	measureLoudness,
	normalizeLoudness,
} from "./loudness/loudness-runner";
import type { LoudnessSummary } from "./loudness/loudness-args";
import type {
	LoudnormMeasurement,
	LoudnormTarget,
} from "./loudness/loudnorm-args";

const BASE_DIR = join(tmpdir(), "streamcuts-loudness");
const UPLOADS_DIR = join(BASE_DIR, "uploads");
const OUTPUTS_DIR = join(BASE_DIR, "outputs");

/** Upload directory for loudness sources; exported for the controller's multer
 * `diskStorage` (mirrors the scene-detect / transcode services). */
export function getLoudnessUploadDirectory(): string {
	mkdirSync(UPLOADS_DIR, { recursive: true });
	return UPLOADS_DIR;
}

/**
 * NestJS service wrapping the loudness core (FAIR-008). Resolves ffmpeg
 * (honouring `FFMPEG_PATH`, else `ffmpeg-static`) and returns the EBU R128
 * summary for an uploaded clip.
 */
export interface NormalizeResult {
	id: string;
	fileName: string;
	/** The pass-1 measurement of the input, in LUFS/dBFS/LU. */
	measured: LoudnormMeasurement;
}

@Injectable()
export class LoudnessService {
	constructor() {
		mkdirSync(UPLOADS_DIR, { recursive: true });
		mkdirSync(OUTPUTS_DIR, { recursive: true });
	}

	private resolveFfmpeg(): string {
		const ffmpeg = process.env.FFMPEG_PATH ?? ffmpegPath;
		if (!ffmpeg) {
			throw new InternalServerErrorException(
				"No ffmpeg binary available. Set FFMPEG_PATH or reinstall backend dependencies.",
			);
		}
		return ffmpeg;
	}

	async measure({
		file,
	}: {
		file: Express.Multer.File | undefined;
	}): Promise<LoudnessSummary> {
		if (!file) {
			throw new BadRequestException("No media uploaded.");
		}
		const ffmpeg = this.resolveFfmpeg();
		try {
			return await measureLoudness({
				ffmpegPath: ffmpeg,
				inputPath: file.path,
			});
		} catch {
			throw new BadRequestException(
				"Loudness measurement failed. The uploaded file may not contain a supported audio track.",
			);
		}
	}

	async normalize({
		file,
		target,
	}: {
		file: Express.Multer.File | undefined;
		target?: LoudnormTarget;
	}): Promise<NormalizeResult> {
		if (!file) {
			throw new BadRequestException("No media uploaded.");
		}
		const ffmpeg = this.resolveFfmpeg();
		const id = randomUUID();
		const fileName = `${id}.wav`;
		const outputPath = join(OUTPUTS_DIR, fileName);
		try {
			const { measured } = await normalizeLoudness({
				ffmpegPath: ffmpeg,
				inputPath: file.path,
				outputPath,
				target,
			});
			return { id, fileName, measured };
		} catch {
			throw new BadRequestException(
				"Loudness normalisation failed. The uploaded file may not contain a supported audio track.",
			);
		}
	}

	getOutputPath(fileName: string): string {
		if (basename(fileName) !== fileName) {
			throw new BadRequestException("Invalid file name.");
		}
		const outputPath = join(OUTPUTS_DIR, fileName);
		if (!existsSync(outputPath)) {
			throw new NotFoundException("Normalised output not found.");
		}
		return outputPath;
	}

	getOutputReadStream(fileName: string): ReadStream {
		return createReadStream(this.getOutputPath(fileName));
	}
}
