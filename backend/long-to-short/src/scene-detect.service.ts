import {
	BadRequestException,
	Injectable,
	InternalServerErrorException,
} from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectScenes } from "./scene-detect/scene-detect-runner";

const BASE_DIR = join(tmpdir(), "streamcuts-scene-detect");
const UPLOADS_DIR = join(BASE_DIR, "uploads");

/** Upload directory for scene-detect sources; exported for the controller's
 * multer `diskStorage` (mirrors the transcode service). */
export function getSceneDetectUploadDirectory(): string {
	mkdirSync(UPLOADS_DIR, { recursive: true });
	return UPLOADS_DIR;
}

export interface SceneDetectResult {
	cuts: number[];
}

/**
 * NestJS service wrapping the scene-detect core (MED-008). Resolves ffmpeg
 * (honouring `FFMPEG_PATH`, else `ffmpeg-static`) and returns the cut list for
 * an uploaded clip.
 */
@Injectable()
export class SceneDetectService {
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

	async detect({
		file,
		threshold,
	}: {
		file: Express.Multer.File | undefined;
		threshold?: number;
	}): Promise<SceneDetectResult> {
		if (!file) {
			throw new BadRequestException("No video uploaded.");
		}
		const ffmpeg = this.resolveFfmpeg();
		try {
			return await detectScenes({
				ffmpegPath: ffmpeg,
				inputPath: file.path,
				threshold,
			});
		} catch {
			throw new BadRequestException(
				"Scene detection failed. The uploaded file may not be a supported video.",
			);
		}
	}
}
