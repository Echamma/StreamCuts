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
import {
	getTranscodeUploadDirectory,
	TranscodeService,
} from "./transcode.service";

/** Map an output extension to its Content-Type (video masters + audio stems). */
function contentTypeFor(fileName: string): string {
	switch (extname(fileName)) {
		case ".mov":
			return "video/quicktime";
		case ".mp3":
			return "audio/mpeg";
		case ".m4a":
			return "audio/mp4";
		case ".wav":
			return "audio/wav";
		case ".flac":
			return "audio/flac";
		default:
			return "video/mp4";
	}
}

const uploadStorage = diskStorage({
	destination: (_request, _file, callback) => {
		callback(null, getTranscodeUploadDirectory());
	},
	filename: (_request, file, callback) => {
		callback(null, `${randomUUID()}${extname(file.originalname) || ".mp4"}`);
	},
});

/**
 * HTTP surface for the transcode jobs (DEL-003 ProRes, MED-005 proxies), shaped
 * like `long-to-short.controller`: POST a `video` upload, get back the result's
 * id + probe summary, then GET the output to download it.
 */
@Controller()
export class TranscodeController {
	constructor(private readonly transcodeService: TranscodeService) {}

	@Post("/api/transcode/proxy")
	@UseInterceptors(FileInterceptor("video", { storage: uploadStorage }))
	async createProxy(
		@UploadedFile() file: Express.Multer.File,
		@Body("height") height?: string,
	) {
		return this.transcodeService.createProxy({
			file,
			height: height ? Number(height) : undefined,
		});
	}

	@Post("/api/transcode/optimized")
	@UseInterceptors(FileInterceptor("video", { storage: uploadStorage }))
	async createOptimized(
		@UploadedFile() file: Express.Multer.File,
		@Body("crf") crf?: string,
	) {
		return this.transcodeService.createOptimized({
			file,
			crf: crf ? Number(crf) : undefined,
		});
	}

	@Post("/api/transcode/prores")
	@UseInterceptors(FileInterceptor("video", { storage: uploadStorage }))
	async createProRes(
		@UploadedFile() file: Express.Multer.File,
		@Body("profile") profile?: string,
	) {
		return this.transcodeService.createProRes({ file, profile });
	}

	@Post("/api/transcode/audio")
	@UseInterceptors(FileInterceptor("video", { storage: uploadStorage }))
	async createAudioExport(
		@UploadedFile() file: Express.Multer.File,
		@Body("format") format?: string,
		@Body("bitrate") bitrate?: string,
	) {
		return this.transcodeService.createAudioExport({ file, format, bitrate });
	}

	@Get("/api/transcode/outputs/:fileName")
	@Header("Access-Control-Expose-Headers", "Content-Disposition")
	download(
		@Param("fileName") fileName: string,
		@Res({ passthrough: true }) response: Response,
	) {
		const outputPath = this.transcodeService.getOutputPath(fileName);
		const stream = this.transcodeService.getOutputReadStream(fileName);

		response.setHeader("Content-Type", contentTypeFor(fileName));
		response.setHeader(
			"Content-Disposition",
			`attachment; filename="${basename(outputPath)}"`,
		);

		return new StreamableFile(stream);
	}
}
