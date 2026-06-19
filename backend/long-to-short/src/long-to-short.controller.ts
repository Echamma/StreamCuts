import {
  BadRequestException,
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
  LongToShortService,
  getUploadDirectory,
} from "./long-to-short.service";

@Controller()
export class LongToShortController {
  constructor(private readonly longToShortService: LongToShortService) {}

  @Get("/api/health")
  getHealth() {
    return {
      ok: true,
      service: "long-to-short-backend",
    };
  }

  @Post("/api/system/open-exports-folder")
  openExportsFolder() {
    return this.longToShortService.revealExportsDirectory();
  }

  @Post("/api/system/open-downloads-folder")
  openDownloadsFolder() {
    return this.longToShortService.revealExportsDirectory();
  }

  @Post("/api/long-to-short/process")
  @UseInterceptors(
    FileInterceptor("video", {
      storage: diskStorage({
        destination: (_request, _file, callback) => {
          callback(null, getUploadDirectory());
        },
        filename: (_request, file, callback) => {
          callback(
            null,
            `${randomUUID()}${extname(file.originalname) || ".mp4"}`,
          );
        },
      }),
    }),
  )
  async processVideo(
    @UploadedFile() file: Express.Multer.File,
    @Body("targetClipSizeMb") targetClipSizeMb?: string,
  ) {
    return this.longToShortService.processVideo(file, {
      targetClipSizeMb: targetClipSizeMb ? Number(targetClipSizeMb) : undefined,
    });
  }

  @Get("/api/long-to-short/jobs/:jobId/clips/:clipName")
  @Header("Access-Control-Expose-Headers", "Content-Disposition")
  downloadClip(
    @Param("jobId") jobId: string,
    @Param("clipName") clipName: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (basename(clipName) !== clipName) {
      throw new BadRequestException("Invalid clip name.");
    }

    const clipPath = this.longToShortService.getClipPath(jobId, clipName);
    const fileStream = this.longToShortService.getClipReadStream(
      jobId,
      clipName,
    );

    response.setHeader("Content-Type", "video/mp4");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${basename(clipPath)}"`,
    );

    return new StreamableFile(fileStream);
  }

  @Post("/api/long-to-short/jobs/:jobId/reveal-folder")
  revealFolder(@Param("jobId") jobId: string) {
    return this.longToShortService.revealJobDirectory(jobId);
  }
}
