import {
	BadRequestException,
	Injectable,
	InternalServerErrorException,
} from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureLoudness } from "./loudness/loudness-runner";
import type { LoudnessSummary } from "./loudness/loudness-args";

const BASE_DIR = join(tmpdir(), "streamcuts-loudness");
const UPLOADS_DIR = join(BASE_DIR, "uploads");

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
@Injectable()
export class LoudnessService {
	constructor() {
		mkdirSync(UPLOADS_DIR, { recursive: true });
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
}
