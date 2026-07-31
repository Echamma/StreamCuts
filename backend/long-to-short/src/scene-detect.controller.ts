import {
	Body,
	Controller,
	Post,
	UploadedFile,
	UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import {
	getSceneDetectUploadDirectory,
	SceneDetectService,
} from "./scene-detect.service";

const uploadStorage = diskStorage({
	destination: (_request, _file, callback) => {
		callback(null, getSceneDetectUploadDirectory());
	},
	filename: (_request, file, callback) => {
		callback(null, `${randomUUID()}${extname(file.originalname) || ".mp4"}`);
	},
});

/**
 * HTTP surface for scene detection (MED-008): POST a `video` upload and get back
 * the cut timestamps. Shaped like the transcode controller.
 */
@Controller()
export class SceneDetectController {
	constructor(private readonly sceneDetectService: SceneDetectService) {}

	@Post("/api/scene-detect")
	@UseInterceptors(FileInterceptor("video", { storage: uploadStorage }))
	async detect(
		@UploadedFile() file: Express.Multer.File,
		@Body("threshold") threshold?: string,
	) {
		return this.sceneDetectService.detect({
			file,
			threshold: threshold ? Number(threshold) : undefined,
		});
	}
}
