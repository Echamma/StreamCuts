import {
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
	getLoudnessUploadDirectory,
	LoudnessService,
} from "./loudness.service";

const uploadStorage = diskStorage({
	destination: (_request, _file, callback) => {
		callback(null, getLoudnessUploadDirectory());
	},
	filename: (_request, file, callback) => {
		callback(null, `${randomUUID()}${extname(file.originalname) || ".mp4"}`);
	},
});

/**
 * HTTP surface for EBU R128 loudness measurement (FAIR-008): POST a `media`
 * upload (audio or video) and get back the integrated loudness, range and true
 * peak. Shaped like the scene-detect controller.
 */
@Controller()
export class LoudnessController {
	constructor(private readonly loudnessService: LoudnessService) {}

	@Post("/api/loudness")
	@UseInterceptors(FileInterceptor("media", { storage: uploadStorage }))
	async measure(@UploadedFile() file: Express.Multer.File) {
		return this.loudnessService.measure({ file });
	}
}
