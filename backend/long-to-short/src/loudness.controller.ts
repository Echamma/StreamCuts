import {
	Body,
	Controller,
	Get,
	Header,
	Param,
	Post,
	Res,
	StreamableFile,
	UploadedFile,
	UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { LoudnormTarget } from "./loudness/loudnorm-args";
import {
	getLoudnessUploadDirectory,
	LoudnessService,
} from "./loudness.service";

/** Read an optional numeric body field (multipart values arrive as strings). */
function optionalNumber(value: string | undefined): number | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

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

	@Post("/api/loudness/normalize")
	@UseInterceptors(FileInterceptor("media", { storage: uploadStorage }))
	async normalize(
		@UploadedFile() file: Express.Multer.File,
		@Body("targetLufs") targetLufs?: string,
		@Body("targetTruePeak") targetTruePeak?: string,
		@Body("targetLra") targetLra?: string,
	) {
		const target: LoudnormTarget = {
			targetLufs: optionalNumber(targetLufs),
			targetTruePeak: optionalNumber(targetTruePeak),
			targetLra: optionalNumber(targetLra),
		};
		return this.loudnessService.normalize({ file, target });
	}

	@Get("/api/loudness/outputs/:fileName")
	@Header("Access-Control-Expose-Headers", "Content-Disposition")
	download(
		@Param("fileName") fileName: string,
		@Res({ passthrough: true }) response: Response,
	) {
		const outputPath = this.loudnessService.getOutputPath(fileName);
		const stream = this.loudnessService.getOutputReadStream(fileName);

		response.setHeader("Content-Type", "audio/wav");
		response.setHeader(
			"Content-Disposition",
			`attachment; filename="${basename(outputPath)}"`,
		);

		return new StreamableFile(stream);
	}
}
