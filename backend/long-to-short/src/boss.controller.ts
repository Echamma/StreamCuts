import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage, memoryStorage } from "multer";
import { BossService } from "./boss.service";
import {
  LongToShortService,
  getUploadDirectory,
  type BossChapter,
  type BossShort,
  type BossHighlight,
} from "./long-to-short.service";

const MEDIA_MULTER_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
};

const BOSS_UPLOAD_MULTER = {
  storage: diskStorage({ destination: getUploadDirectory() }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024 },
};

@Controller()
export class BossController {
  constructor(
    private readonly bossService: BossService,
    private readonly longToShortService: LongToShortService,
  ) {}

  // ── Boss pipeline ──────────────────────────────────────────────────────

  @Post("/api/boss/upload")
  @UseInterceptors(FileInterceptor("video", BOSS_UPLOAD_MULTER))
  bossUpload(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException("A video file is required.");
    }
    return this.longToShortService.bossSaveUpload(file);
  }

  @Post("/api/boss/transcribe")
  bossTranscribe(@Body("jobId") jobId: unknown) {
    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new BadRequestException("jobId is required.");
    }
    return this.longToShortService.bossTranscribe({ jobId: jobId.trim() });
  }

  @Post("/api/boss/plan-cuts")
  async bossPlanCuts(@Body() body: unknown) {
    if (!isRecord(body)) {
      throw new BadRequestException("Invalid request body.");
    }
    const { jobId, prompt, segments, durationSeconds } = body as Record<string, unknown>;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new BadRequestException("jobId is required.");
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new BadRequestException("prompt is required.");
    }
    if (!Array.isArray(segments)) {
      throw new BadRequestException("segments must be an array.");
    }
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new BadRequestException("durationSeconds must be a positive number.");
    }

    const parsedSegments = segments
      .filter(
        (s): s is { start: number; end: number; text: string } =>
          isRecord(s) &&
          typeof s.start === "number" &&
          typeof s.end === "number" &&
          typeof s.text === "string",
      )
      .map((s) => ({ start: s.start, end: s.end, text: s.text }));

    return this.longToShortService.bossPlanCuts({
      jobId: jobId.trim(),
      prompt: prompt.trim(),
      segments: parsedSegments,
      durationSeconds: duration,
    });
  }

  @Post("/api/boss/render")
  async bossRender(@Body() body: unknown) {
    if (!isRecord(body)) {
      throw new BadRequestException("Invalid request body.");
    }
    const { jobId, longerSegments, shorts } = body as Record<string, unknown>;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new BadRequestException("jobId is required.");
    }
    if (!Array.isArray(longerSegments)) {
      throw new BadRequestException("longerSegments must be an array.");
    }
    if (!Array.isArray(shorts)) {
      throw new BadRequestException("shorts must be an array.");
    }

    const parsedLonger: BossChapter[] = longerSegments
      .filter(
        (s): s is { startSeconds: number; endSeconds: number; title: string } =>
          isRecord(s) &&
          typeof s.startSeconds === "number" &&
          typeof s.endSeconds === "number" &&
          typeof s.title === "string",
      )
      .map((s) => ({
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        title: s.title,
      }));

    const parsedShorts: BossShort[] = shorts
      .filter(
        (s): s is {
          startSeconds: number;
          endSeconds: number;
          title: string;
          description: string;
        } =>
          isRecord(s) &&
          typeof s.startSeconds === "number" &&
          typeof s.endSeconds === "number" &&
          typeof s.title === "string" &&
          typeof s.description === "string",
      )
      .map((s) => ({
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        title: s.title,
        description: s.description,
      }));

    return this.longToShortService.bossRender({
      jobId: jobId.trim(),
      longerSegments: parsedLonger,
      shorts: parsedShorts,
    });
  }

  // ── Summarize pipeline ─────────────────────────────────────────────────

  @Post("/api/boss/summarize-plan")
  async bossSummarizePlan(@Body() body: unknown) {
    if (!isRecord(body)) {
      throw new BadRequestException("Invalid request body.");
    }
    const { jobId, segments, durationSeconds, targetSeconds, focus } =
      body as Record<string, unknown>;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new BadRequestException("jobId is required.");
    }
    if (!Array.isArray(segments)) {
      throw new BadRequestException("segments must be an array.");
    }
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new BadRequestException("durationSeconds must be a positive number.");
    }
    const target = Number(targetSeconds);
    if (!Number.isFinite(target) || target <= 0) {
      throw new BadRequestException("targetSeconds must be a positive number.");
    }

    const parsedSegments = segments
      .filter(
        (s): s is { start: number; end: number; text: string } =>
          isRecord(s) &&
          typeof s.start === "number" &&
          typeof s.end === "number" &&
          typeof s.text === "string",
      )
      .map((s) => ({ start: s.start, end: s.end, text: s.text }));

    return this.longToShortService.bossSummarizePlan({
      jobId: jobId.trim(),
      segments: parsedSegments,
      durationSeconds: duration,
      targetSeconds: target,
      focus: typeof focus === "string" ? focus.trim() : undefined,
    });
  }

  @Post("/api/boss/summarize-render")
  async bossSummarizeRender(@Body() body: unknown) {
    if (!isRecord(body)) {
      throw new BadRequestException("Invalid request body.");
    }
    const { jobId, highlights } = body as Record<string, unknown>;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new BadRequestException("jobId is required.");
    }
    if (!Array.isArray(highlights)) {
      throw new BadRequestException("highlights must be an array.");
    }

    const parsedHighlights: BossHighlight[] = highlights
      .filter(
        (h): h is { startSeconds: number; endSeconds: number; reason?: unknown } =>
          isRecord(h) &&
          typeof h.startSeconds === "number" &&
          typeof h.endSeconds === "number" &&
          h.endSeconds > h.startSeconds,
      )
      .map((h) => ({
        startSeconds: h.startSeconds,
        endSeconds: h.endSeconds,
        reason: typeof h.reason === "string" ? h.reason : "",
      }));

    if (parsedHighlights.length === 0) {
      throw new BadRequestException("No valid highlights were provided.");
    }

    return this.longToShortService.bossSummarizeRender({
      jobId: jobId.trim(),
      highlights: parsedHighlights,
    });
  }

  // ── Legacy endpoints ───────────────────────────────────────────────────

  @Post("/api/boss/cue-suggestions")
  getCueSuggestions(
    @Body("durationSeconds") durationSeconds: unknown,
    @Body("userPrompt") userPrompt: unknown,
  ) {
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new BadRequestException("durationSeconds must be a positive number.");
    }
    if (typeof userPrompt !== "string" || !userPrompt.trim()) {
      throw new BadRequestException("userPrompt is required.");
    }
    return this.bossService.requestCueSuggestions({
      durationSeconds: duration,
      userPrompt: userPrompt.trim(),
    });
  }

  @Post("/api/boss/segment-metadata")
  @UseInterceptors(FileInterceptor("media", MEDIA_MULTER_OPTIONS))
  getSegmentMetadata(
    @UploadedFile() file: Express.Multer.File,
    @Body("index") indexRaw: string,
    @Body("total") totalRaw: string,
    @Body("durationSeconds") durationSecondsRaw: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("media file is required.");
    }
    const index = Number(indexRaw);
    const total = Number(totalRaw);
    const durationSeconds = Number(durationSecondsRaw);
    if (!Number.isInteger(index) || index < 0) {
      throw new BadRequestException("index must be a non-negative integer.");
    }
    if (!Number.isInteger(total) || total <= 0) {
      throw new BadRequestException("total must be a positive integer.");
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new BadRequestException("durationSeconds must be a positive number.");
    }
    return this.bossService.generateSegmentMetadata({
      mediaBuffer: file.buffer,
      mimeType: file.mimetype,
      index,
      total,
      durationSeconds,
    });
  }

  @Post("/api/boss/short-plan")
  @UseInterceptors(FileInterceptor("media", MEDIA_MULTER_OPTIONS))
  getShortPlan(
    @UploadedFile() file: Express.Multer.File,
    @Body("durationSeconds") durationSecondsRaw: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("media file is required.");
    }
    const durationSeconds = Number(durationSecondsRaw);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new BadRequestException("durationSeconds must be a positive number.");
    }
    return this.bossService.generateShortPlan({
      mediaBuffer: file.buffer,
      mimeType: file.mimetype,
      durationSeconds,
    });
  }

  @Post("/api/boss/subtitles")
  @UseInterceptors(FileInterceptor("media", MEDIA_MULTER_OPTIONS))
  async getSubtitles(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("media file is required.");
    }
    const srt = await this.bossService.generateSubtitlesSrt({
      mediaBuffer: file.buffer,
      mimeType: file.mimetype,
    });
    return { srt };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
