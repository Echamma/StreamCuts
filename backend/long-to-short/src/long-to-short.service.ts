import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "ffprobe-static";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  TranscriptionService,
  type TranscriptionSegment,
} from "./transcription.service";

const execFileAsync = promisify(execFile);
const dataDirectory = resolve(process.cwd(), "data");
const uploadsDirectory = join(dataDirectory, "uploads");
const jobsDirectory = join(dataDirectory, "jobs");

type ProbeResult = {
  format?: {
    duration?: string;
    bit_rate?: string;
  };
};

export type ProcessVideoInput = {
  targetClipSizeMb?: number;
};

export type ClipResult = {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  estimatedSourceSizeMb: number | null;
  renderedSizeMb: number;
  downloadUrl: string;
  socialCopy: SocialCopy;
};

export type ProcessVideoResult = {
  jobId: string;
  originalFileName: string;
  sourceDurationSeconds: number;
  clipCount: number;
  targetClipSizeMb: number | null;
  clips: ClipResult[];
};

type PlannedClip = {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
};

type PlannedClipJob = PlannedClip & {
  id: string;
  label: string;
  clipFileName: string;
};

type AutomaticClipPlanConfig = {
  clipCount: number;
  maxClipDurationSeconds: number;
};

type SocialCopyProvider = "gemini" | "fallback";

export type SocialCopy = {
  platform: "tiktok";
  provider: SocialCopyProvider;
  title: string;
  description: string;
};

export type BossChapter = {
  startSeconds: number;
  endSeconds: number;
  title: string;
};

export type BossShort = {
  startSeconds: number;
  endSeconds: number;
  title: string;
  description: string;
};

export type BossPlanningSettings = {
  minChapters: number;
  maxChapters: number;
  minChapterDurationSeconds: number;
  minShortsPerSegment: number;
  maxShortsPerSegment: number;
  minShortDurationSeconds: number;
  maxShortDurationSeconds: number;
};

export type BossHighlight = {
  startSeconds: number;
  endSeconds: number;
  reason: string;
};

export type BossSummaryResult = {
  downloadUrl: string;
  title: string;
  durationSeconds: number;
  segmentCount: number;
};

export type BossRenderedClip = { downloadUrl: string; title: string };
export type BossRenderedShort = { downloadUrl: string; title: string; description: string };

export const DEFAULT_BOSS_PLANNING_SETTINGS: BossPlanningSettings = {
  minChapters: 2,
  maxChapters: 10,
  minChapterDurationSeconds: 30,
  minShortsPerSegment: 1,
  maxShortsPerSegment: 3,
  minShortDurationSeconds: 15,
  maxShortDurationSeconds: 90,
};

type GeminiSocialCopyResult = {
  clipId: string;
  title: string;
  description: string;
};

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeBossPlanningSettings(
  settings?: Partial<BossPlanningSettings>,
): BossPlanningSettings {
  const next = {
    ...DEFAULT_BOSS_PLANNING_SETTINGS,
    ...settings,
  };

  const minChapters = clampInteger(next.minChapters, 1, 20);
  const maxChapters = clampInteger(next.maxChapters, minChapters, 20);
  const minChapterDurationSeconds = clampInteger(
    next.minChapterDurationSeconds,
    5,
    3600,
  );
  const minShortsPerSegment = clampInteger(next.minShortsPerSegment, 1, 5);
  const maxShortsPerSegment = clampInteger(
    next.maxShortsPerSegment,
    minShortsPerSegment,
    5,
  );
  const minShortDurationSeconds = clampInteger(
    next.minShortDurationSeconds,
    5,
    180,
  );
  const maxShortDurationSeconds = clampInteger(
    next.maxShortDurationSeconds,
    minShortDurationSeconds,
    180,
  );

  return {
    minChapters,
    maxChapters,
    minChapterDurationSeconds,
    minShortsPerSegment,
    maxShortsPerSegment,
    minShortDurationSeconds,
    maxShortDurationSeconds,
  };
}

@Injectable()
export class LongToShortService {
  private readonly logger = new Logger(LongToShortService.name);
  private readonly uploadsDir = uploadsDirectory;
  private readonly jobsDir = jobsDirectory;
  private readonly geminiApiKey = (process.env.GEMINI_API_KEY ?? "").trim();
  private readonly geminiModel =
    (process.env.GEMINI_MODEL ?? "gemini-3.5-flash").trim() ||
    "gemini-3.5-flash";

  constructor(private readonly transcriptionService: TranscriptionService) {
    mkdirSync(this.uploadsDir, { recursive: true });
    mkdirSync(this.jobsDir, { recursive: true });
  }

  getUploadDirectory() {
    return this.uploadsDir;
  }

  getClipReadStream(jobId: string, clipName: string) {
    const safeClipName = basename(clipName);
    const clipPath = join(this.jobsDir, jobId, safeClipName);

    if (!existsSync(clipPath)) {
      throw new BadRequestException("Clip not found.");
    }

    return createReadStream(clipPath);
  }

  getClipPath(jobId: string, clipName: string) {
    const safeClipName = basename(clipName);
    const clipPath = join(this.jobsDir, jobId, safeClipName);

    if (!existsSync(clipPath)) {
      throw new BadRequestException("Clip not found.");
    }

    return clipPath;
  }

  getJobDirectory(jobId: string) {
    const jobDir = join(this.jobsDir, jobId);

    if (!existsSync(jobDir)) {
      throw new BadRequestException("Job not found.");
    }

    return jobDir;
  }

  async revealJobDirectory(jobId: string) {
    const jobDir = this.getJobDirectory(jobId);

    if (process.platform !== "win32") {
      throw new InternalServerErrorException(
        "Opening the extract folder is currently supported only on Windows.",
      );
    }

    try {
      await this.openFolderInExplorer(jobDir);
    } catch (error) {
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr.trim()
          : "";

      if (stderr) {
        this.logger.error(`Failed to open extract folder ${jobDir}: ${stderr}`);
      }

      throw new InternalServerErrorException(
        "Could not open the extract folder.",
      );
    }

    return {
      ok: true,
      jobId,
      folderPath: jobDir,
    };
  }

  async revealExportsDirectory() {
    if (process.platform !== "win32") {
      throw new InternalServerErrorException(
        "Opening the exports folder is currently supported only on Windows.",
      );
    }

    const exportsDir =
      process.env.EXPORTS_DIR ??
      process.env.DOWNLOADS_DIR ??
      join(homedir(), "Downloads");

    if (!existsSync(exportsDir)) {
      throw new InternalServerErrorException(
        `Exports folder was not found at ${exportsDir}.`,
      );
    }

    try {
      await this.openFolderInExplorer(exportsDir);
    } catch (error) {
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr.trim()
          : "";

      if (stderr) {
        this.logger.error(
          `Failed to open exports folder ${exportsDir}: ${stderr}`,
        );
      }

      throw new InternalServerErrorException(
        "Could not open the exports folder.",
      );
    }

    return {
      ok: true,
      folderPath: exportsDir,
    };
  }

  async processVideo(file: Express.Multer.File, input: ProcessVideoInput) {
    if (!file) {
      throw new BadRequestException("A video file is required.");
    }

    const targetClipSizeMb = input.targetClipSizeMb
      ? Number(input.targetClipSizeMb)
      : undefined;

    if (
      targetClipSizeMb !== undefined &&
      (!Number.isFinite(targetClipSizeMb) || targetClipSizeMb <= 0)
    ) {
      throw new BadRequestException(
        "targetClipSizeMb must be greater than 0 when provided.",
      );
    }

    if (!ffmpegPath || !ffprobePath) {
      throw new InternalServerErrorException(
        "The bundled ffmpeg binaries are unavailable. Reinstall backend dependencies.",
      );
    }

    const resolvedFfmpegPath = ffmpegPath;
    const resolvedFfprobePath = ffprobePath;

    const jobId = randomUUID();
    const jobDir = join(this.jobsDir, jobId);
    mkdirSync(jobDir, { recursive: true });

    const sourceExtension = extname(file.originalname) || ".mp4";
    const sourcePath = join(jobDir, `source${sourceExtension}`);
    renameSync(file.path, sourcePath);

    const probe = await this.probeVideo(sourcePath, resolvedFfprobePath);
    const durationSeconds = Number(probe.format?.duration ?? 0);

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new BadRequestException("Could not determine the video duration.");
    }

    const sourceBitRate = Number(probe.format?.bit_rate ?? 0);

    let plannedClips: PlannedClipJob[];
    let prefetchedTranscriptSegments: TranscriptionSegment[] | undefined;
    const automaticPlanConfig =
      this.getAutomaticClipPlanConfig(durationSeconds);

    if (this.geminiApiKey) {
      try {
        const geminiPlan = await this.planClipsWithGemini({
          jobId,
          sourcePath,
          originalFileName: file.originalname,
          durationSeconds,
          fallbackPlanConfig: automaticPlanConfig,
        });
        plannedClips = geminiPlan.clips;
        prefetchedTranscriptSegments = geminiPlan.transcriptionSegments;
      } catch (error) {
        this.logger.warn(
          `Gemini clip planning failed for ${file.originalname}, falling back to sequential: ${this.getErrorMessage(error)}`,
        );
        plannedClips = this.planClips({
          totalDurationSeconds: durationSeconds,
          ...automaticPlanConfig,
        }).map((clip, index) => ({
          ...clip,
          id: `${jobId}-${index + 1}`,
          label: `Clip ${index + 1}`,
          clipFileName: `clip-${index + 1}.mp4`,
        }));
      }
    } else {
      plannedClips = this.planClips({
        totalDurationSeconds: durationSeconds,
        ...automaticPlanConfig,
      }).map((clip, index) => ({
        ...clip,
        id: `${jobId}-${index + 1}`,
        label: `Clip ${index + 1}`,
        clipFileName: `clip-${index + 1}.mp4`,
      }));
    }

    const transcriptByClipId = await this.buildClipTranscriptMap({
      sourcePath,
      originalFileName: file.originalname,
      clips: plannedClips,
      existingSegments: prefetchedTranscriptSegments,
    });
    const socialCopyByClipId = await this.buildSocialCopyByClipId({
      originalFileName: file.originalname,
      clips: plannedClips,
      transcriptByClipId,
    });

    const renderedClips: ClipResult[] = [];

    for (const clip of plannedClips) {
      const outputPath = join(jobDir, clip.clipFileName);

      await this.renderClip({
        ffmpegBinaryPath: resolvedFfmpegPath,
        inputPath: sourcePath,
        outputPath,
        startSeconds: clip.startSeconds,
        durationSeconds: clip.durationSeconds,
        targetClipSizeMb,
      });

      const outputStats = statSync(outputPath);
      const estimatedSourceSizeMb =
        sourceBitRate > 0
          ? this.roundTo(
              (sourceBitRate * clip.durationSeconds) / 8 / 1024 / 1024,
              2,
            )
          : null;

      renderedClips.push({
        id: clip.id,
        label: clip.label,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        durationSeconds: clip.durationSeconds,
        estimatedSourceSizeMb,
        renderedSizeMb: this.roundTo(outputStats.size / 1024 / 1024, 2),
        downloadUrl: `/api/long-to-short/jobs/${jobId}/clips/${clip.clipFileName}`,
        socialCopy:
          socialCopyByClipId.get(clip.id) ??
          this.buildFallbackSocialCopy({
            clip,
            originalFileName: file.originalname,
            transcript: transcriptByClipId.get(clip.id) ?? "",
          }),
      });
    }

    return {
      jobId,
      originalFileName: file.originalname,
      sourceDurationSeconds: this.roundTo(durationSeconds, 2),
      clipCount: renderedClips.length,
      targetClipSizeMb: targetClipSizeMb ?? null,
      clips: renderedClips,
    } satisfies ProcessVideoResult;
  }

  // ── Boss panel pipeline ────────────────────────────────────────────────

  async bossSaveUpload(file: Express.Multer.File): Promise<{
    jobId: string;
    sourceDurationSeconds: number;
    sourceFileName: string;
  }> {
    if (!file) {
      throw new BadRequestException("A video file is required.");
    }
    if (!ffprobePath) {
      throw new InternalServerErrorException(
        "The bundled ffprobe binary is unavailable. Reinstall backend dependencies.",
      );
    }

    const jobId = randomUUID();
    const jobDir = join(this.jobsDir, jobId);
    mkdirSync(jobDir, { recursive: true });

    const sourceExtension = extname(file.originalname) || ".mp4";
    const sourcePath = join(jobDir, `source${sourceExtension}`);
    renameSync(file.path, sourcePath);

    const probe = await this.probeVideo(sourcePath, ffprobePath);
    const durationSeconds = Number(probe.format?.duration ?? 0);

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new BadRequestException("Could not determine the video duration.");
    }

    return {
      jobId,
      sourceDurationSeconds: this.roundTo(durationSeconds, 2),
      sourceFileName: file.originalname,
    };
  }

  async bossTranscribe({ jobId }: { jobId: string }): Promise<{
    segments: TranscriptionSegment[];
  }> {
    const sourcePath = this.findSourceFile(jobId);

    try {
      const transcription = await this.transcriptionService.transcribeFilePath({
        inputPath: sourcePath,
        originalName: basename(sourcePath),
        profile: "longform",
        deleteAfter: false,
      });
      return { segments: transcription.segments };
    } catch (error) {
      this.logger.warn(
        `Boss transcription failed for job ${jobId}: ${this.getErrorMessage(error)}`,
      );
      return { segments: [] };
    }
  }

  async bossPlanCuts({
    jobId,
    prompt,
    segments,
    durationSeconds,
    settings,
  }: {
    jobId: string;
    prompt: string;
    segments: TranscriptionSegment[];
    durationSeconds: number;
    settings?: Partial<BossPlanningSettings>;
  }): Promise<{
    longerSegments: BossChapter[];
    shorts: BossShort[];
  }> {
    if (!this.geminiApiKey) {
      throw new InternalServerErrorException(
        "GEMINI_API_KEY is not configured. Add it to backend/long-to-short/.env.",
      );
    }

    this.logger.log(`Boss planning cuts for job ${jobId} (${durationSeconds.toFixed(0)}s)`);
    const planningSettings = normalizeBossPlanningSettings(settings);

    const transcriptText =
      segments.length > 0
        ? this.truncateText(
            segments
              .map(
                (seg) =>
                  `[${this.formatSecondsAsTimestamp(seg.start)}-${this.formatSecondsAsTimestamp(seg.end)}] ${this.normalizeWhitespace(seg.text)}`,
              )
              .filter(Boolean)
              .join("\n"),
            40000,
          )
        : "";

    const longerSegments = await this.bossGeminiPlanChapters({
      prompt,
      transcriptText,
      durationSeconds,
      settings: planningSettings,
    });

    if (longerSegments.length === 0) {
      throw new InternalServerErrorException(
        "Gemini could not plan any cuts from your instructions. Try rephrasing your prompt.",
      );
    }

    const shorts = await this.bossGeminiPlanShorts({
      longerSegments,
      transcriptSegments: segments,
      durationSeconds,
      settings: planningSettings,
    });

    return { longerSegments, shorts };
  }

  async bossRender({
    jobId,
    longerSegments,
    shorts,
  }: {
    jobId: string;
    longerSegments: BossChapter[];
    shorts: BossShort[];
  }): Promise<{
    longerVideos: BossRenderedClip[];
    shorts: BossRenderedShort[];
  }> {
    if (!ffmpegPath) {
      throw new InternalServerErrorException(
        "The bundled ffmpeg binary is unavailable. Reinstall backend dependencies.",
      );
    }

    const sourcePath = this.findSourceFile(jobId);
    const jobDir = join(this.jobsDir, jobId);
    const resolvedFfmpegPath = ffmpegPath;

    const longerVideos: BossRenderedClip[] = [];
    for (let i = 0; i < longerSegments.length; i++) {
      const seg = longerSegments[i];
      const fileName = `longer-${i + 1}.mp4`;
      const outputPath = join(jobDir, fileName);
      await this.bossRenderClipCopy({
        ffmpegBinaryPath: resolvedFfmpegPath,
        inputPath: sourcePath,
        outputPath,
        startSeconds: seg.startSeconds,
        durationSeconds: this.roundTo(seg.endSeconds - seg.startSeconds, 2),
      });
      longerVideos.push({
        downloadUrl: `/api/long-to-short/jobs/${jobId}/clips/${fileName}`,
        title: seg.title,
      });
    }

    const renderedShorts: BossRenderedShort[] = [];
    for (let i = 0; i < shorts.length; i++) {
      const short = shorts[i];
      const fileName = `short-${i + 1}.mp4`;
      const outputPath = join(jobDir, fileName);
      await this.renderClip({
        ffmpegBinaryPath: resolvedFfmpegPath,
        inputPath: sourcePath,
        outputPath,
        startSeconds: short.startSeconds,
        durationSeconds: this.roundTo(short.endSeconds - short.startSeconds, 2),
      });
      renderedShorts.push({
        downloadUrl: `/api/long-to-short/jobs/${jobId}/clips/${fileName}`,
        title: short.title,
        description: short.description,
      });
    }

    return { longerVideos, shorts: renderedShorts };
  }

  // ── Summarize pipeline ─────────────────────────────────────────────────

  async bossSummarizePlan({
    jobId,
    segments,
    durationSeconds,
    targetSeconds,
    focus,
  }: {
    jobId: string;
    segments: TranscriptionSegment[];
    durationSeconds: number;
    targetSeconds: number;
    focus?: string;
  }): Promise<{ highlights: BossHighlight[]; totalSeconds: number }> {
    if (!this.geminiApiKey) {
      throw new InternalServerErrorException(
        "GEMINI_API_KEY is not configured. Add it to backend/long-to-short/.env.",
      );
    }
    if (segments.length === 0) {
      throw new InternalServerErrorException(
        "Transcription produced no text, so this video can't be summarized.",
      );
    }
    if (targetSeconds >= durationSeconds) {
      throw new BadRequestException(
        "The target length must be shorter than the source video.",
      );
    }

    this.logger.log(
      `Boss summarizing job ${jobId} (${durationSeconds.toFixed(0)}s -> ${targetSeconds.toFixed(0)}s)`,
    );

    // Long VODs produce large transcripts; allow a generous cap so highlights
    // can be drawn from the whole video, not just the first chunk.
    const transcriptText = this.truncateText(
      segments
        .map(
          (seg) =>
            `[${this.formatSecondsAsTimestamp(seg.start)}-${this.formatSecondsAsTimestamp(seg.end)}] ${this.normalizeWhitespace(seg.text)}`,
        )
        .filter(Boolean)
        .join("\n"),
      400000,
    );

    const highlights = await this.bossGeminiPlanHighlights({
      transcriptText,
      durationSeconds,
      targetSeconds,
      focus,
    });

    if (highlights.length === 0) {
      throw new InternalServerErrorException(
        "Gemini could not pick any highlights for this summary. Try a longer target length.",
      );
    }

    const totalSeconds = this.roundTo(
      highlights.reduce((sum, h) => sum + (h.endSeconds - h.startSeconds), 0),
      2,
    );

    return { highlights, totalSeconds };
  }

  async bossSummarizeRender({
    jobId,
    highlights,
  }: {
    jobId: string;
    highlights: BossHighlight[];
  }): Promise<BossSummaryResult> {
    if (!ffmpegPath) {
      throw new InternalServerErrorException(
        "The bundled ffmpeg binary is unavailable. Reinstall backend dependencies.",
      );
    }
    if (highlights.length === 0) {
      throw new BadRequestException("No highlights to render.");
    }

    const sourcePath = this.findSourceFile(jobId);
    const jobDir = join(this.jobsDir, jobId);
    const resolvedFfmpegPath = ffmpegPath;

    // Re-encode every highlight to identical codec params so the segments can
    // be concatenated losslessly afterwards.
    const segmentPaths: string[] = [];
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      const segPath = join(jobDir, `summary-seg-${i + 1}.mp4`);
      await this.bossRenderSegmentReencode({
        ffmpegBinaryPath: resolvedFfmpegPath,
        inputPath: sourcePath,
        outputPath: segPath,
        startSeconds: h.startSeconds,
        durationSeconds: this.roundTo(h.endSeconds - h.startSeconds, 2),
      });
      segmentPaths.push(segPath);
    }

    const fileName = "summary.mp4";
    const outputPath = join(jobDir, fileName);

    if (segmentPaths.length === 1) {
      copyFileSync(segmentPaths[0], outputPath);
    } else {
      await this.concatSegments({
        ffmpegBinaryPath: resolvedFfmpegPath,
        jobDir,
        segmentPaths,
        outputPath,
      });
    }

    for (const segPath of segmentPaths) {
      try {
        unlinkSync(segPath);
      } catch {
        // best-effort cleanup of temp segments
      }
    }

    const durationSeconds = this.roundTo(
      highlights.reduce((sum, h) => sum + (h.endSeconds - h.startSeconds), 0),
      2,
    );

    return {
      downloadUrl: `/api/long-to-short/jobs/${jobId}/clips/${fileName}`,
      title: "Summary",
      durationSeconds,
      segmentCount: highlights.length,
    };
  }

  private async probeVideo(sourcePath: string, ffprobeBinaryPath: string) {
    try {
      const { stdout, stderr } = await execFileAsync(
        ffprobeBinaryPath,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration,bit_rate",
          "-of",
          "json",
          sourcePath,
        ],
        { encoding: "utf8" },
      );

      if (stderr) {
        this.logger.warn(stderr);
      }

      return JSON.parse(stdout) as ProbeResult;
    } catch (error) {
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr.trim()
          : "";

      if (stderr) {
        this.logger.error(`ffprobe failed for ${sourcePath}: ${stderr}`);
      }

      throw new BadRequestException(
        "The uploaded file could not be read as a supported video.",
      );
    }
  }

  private async buildClipTranscriptMap({
    sourcePath,
    originalFileName,
    clips,
    existingSegments,
  }: {
    sourcePath: string;
    originalFileName: string;
    clips: PlannedClipJob[];
    existingSegments?: TranscriptionSegment[];
  }) {
    try {
      const segments =
        existingSegments ??
        (
          await this.transcriptionService.transcribeFilePath({
            inputPath: sourcePath,
            originalName: originalFileName,
            profile: "longform",
            deleteAfter: false,
          })
        ).segments;

      return new Map(
        clips.map((clip) => [
          clip.id,
          this.getTranscriptSnippetForClip({ clip, segments }),
        ]),
      );
    } catch (error) {
      this.logger.warn(
        `Skipping transcript-aware TikTok copy for ${originalFileName}: ${this.getErrorMessage(error)}`,
      );
      return new Map<string, string>();
    }
  }

  private getTranscriptSnippetForClip({
    clip,
    segments,
  }: {
    clip: PlannedClipJob;
    segments: TranscriptionSegment[];
  }) {
    const text = segments
      .filter(
        (segment) =>
          segment.end > clip.startSeconds && segment.start < clip.endSeconds,
      )
      .map((segment) => this.normalizeWhitespace(segment.text))
      .filter(Boolean)
      .join(" ");

    return this.truncateText(this.normalizeWhitespace(text), 1400);
  }

  private async buildSocialCopyByClipId({
    originalFileName,
    clips,
    transcriptByClipId,
  }: {
    originalFileName: string;
    clips: PlannedClipJob[];
    transcriptByClipId: Map<string, string>;
  }) {
    const fallbackByClipId = new Map(
      clips.map((clip) => [
        clip.id,
        this.buildFallbackSocialCopy({
          clip,
          originalFileName,
          transcript: transcriptByClipId.get(clip.id) ?? "",
        }),
      ]),
    );

    if (!this.geminiApiKey) {
      return fallbackByClipId;
    }

    try {
      const geminiResults = await this.generateGeminiSocialCopy({
        originalFileName,
        clips,
        transcriptByClipId,
      });
      const geminiByClipId = new Map(
        geminiResults.map((item) => [item.clipId, item]),
      );

      return new Map(
        clips.map((clip) => {
          const geminiCopy = geminiByClipId.get(clip.id);
          const fallbackCopy = fallbackByClipId.get(clip.id);

          if (!geminiCopy || !fallbackCopy) {
            return [clip.id, fallbackCopy] as const;
          }

          const normalizedTitle = this.normalizeSuggestedTitle(
            geminiCopy.title,
          );
          const normalizedDescription = this.normalizeSuggestedDescription(
            geminiCopy.description,
          );

          if (!normalizedTitle || !normalizedDescription) {
            return [clip.id, fallbackCopy] as const;
          }

          return [
            clip.id,
            {
              platform: "tiktok" as const,
              provider: "gemini" as const,
              title: normalizedTitle,
              description: normalizedDescription,
            },
          ] as const;
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Gemini TikTok copy generation failed for ${originalFileName}: ${this.getErrorMessage(error)}`,
      );
      return fallbackByClipId;
    }
  }

  private buildFallbackSocialCopy({
    clip,
    originalFileName,
    transcript,
  }: {
    clip: PlannedClipJob;
    originalFileName: string;
    transcript: string;
  }): SocialCopy {
    const normalizedTranscript = this.normalizeWhitespace(transcript);
    const fallbackTitle =
      this.normalizeSuggestedTitle(
        this.truncateText(
          normalizedTranscript ||
            `${this.humanizeFileName(originalFileName)} ${clip.label}`,
          78,
        ),
      ) || `${this.humanizeFileName(originalFileName)} ${clip.label}`.trim();

    const summary =
      this.normalizeSuggestedDescription(
        normalizedTranscript
          ? `${this.truncateText(normalizedTranscript, 260)}\n\n#tiktok #shortform #videoclips`
          : `Highlight from ${this.humanizeFileName(originalFileName)}.\n\n#tiktok #shortform #videoclips`,
      ) || `Highlight from ${clip.label}.\n\n#tiktok #shortform #videoclips`;

    return {
      platform: "tiktok",
      provider: "fallback",
      title: fallbackTitle,
      description: summary,
    };
  }

  private async generateGeminiSocialCopy({
    originalFileName,
    clips,
    transcriptByClipId,
  }: {
    originalFileName: string;
    clips: PlannedClipJob[];
    transcriptByClipId: Map<string, string>;
  }) {
    const promptPayload = clips.map((clip) => ({
      clipId: clip.id,
      label: clip.label,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      durationSeconds: clip.durationSeconds,
      transcript: transcriptByClipId.get(clip.id) ?? "",
    }));

    const prompt = [
      "Create TikTok-ready copy for each clip.",
      "Return raw JSON only with this exact shape:",
      '[{"clipId":"string","title":"string","description":"string"}]',
      "Rules:",
      "- Ground every title and description only in the supplied transcript snippet.",
      "- Keep titles punchy and under 80 characters.",
      "- Keep descriptions under 400 characters.",
      "- Descriptions may include 3 to 6 relevant hashtags at the end.",
      "- Do not use markdown, backticks, numbering, or extra commentary.",
      `Source file: ${originalFileName}`,
      "Clips:",
      JSON.stringify(promptPayload, null, 2),
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        this.geminiModel,
      )}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.geminiApiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(await this.readGeminiErrorMessage(response));
    }

    const payload: unknown = await response.json();
    const responseText = this.extractGeminiText(payload);
    return this.parseGeminiSocialCopy(responseText);
  }

  private async readGeminiErrorMessage(response: Response) {
    const fallbackMessage = `Gemini request failed with status ${response.status}.`;

    try {
      const payload: unknown = JSON.parse(await response.text());
      if (!isRecord(payload) || !isRecord(payload.error)) {
        return fallbackMessage;
      }

      return typeof payload.error.message === "string"
        ? payload.error.message
        : fallbackMessage;
    } catch {
      return fallbackMessage;
    }
  }

  private extractGeminiText(payload: unknown) {
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
      throw new Error("Gemini returned an invalid response payload.");
    }

    const candidate = payload.candidates.find((item) => isRecord(item));
    if (
      !candidate ||
      !isRecord(candidate.content) ||
      !Array.isArray(candidate.content.parts)
    ) {
      throw new Error("Gemini returned no content.");
    }

    const text = candidate.content.parts
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Gemini returned an empty response.");
    }

    return text;
  }

  private parseGeminiSocialCopy(text: string) {
    const normalizedText = this.extractJsonPayload(text);
    const payload: unknown = JSON.parse(normalizedText);

    if (!Array.isArray(payload)) {
      throw new Error("Gemini returned invalid social copy JSON.");
    }

    return payload
      .map((item): GeminiSocialCopyResult | null => {
        if (
          !isRecord(item) ||
          typeof item.clipId !== "string" ||
          typeof item.title !== "string" ||
          typeof item.description !== "string"
        ) {
          return null;
        }

        return {
          clipId: item.clipId,
          title: item.title,
          description: item.description,
        };
      })
      .filter((item): item is GeminiSocialCopyResult => item !== null);
  }

  private extractJsonPayload(text: string) {
    const withoutFence = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    if (withoutFence.startsWith("[") || withoutFence.startsWith("{")) {
      return withoutFence;
    }

    const arrayStart = withoutFence.indexOf("[");
    const arrayEnd = withoutFence.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
      return withoutFence.slice(arrayStart, arrayEnd + 1);
    }

    const objectStart = withoutFence.indexOf("{");
    const objectEnd = withoutFence.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
      return withoutFence.slice(objectStart, objectEnd + 1);
    }

    throw new Error("Gemini response did not contain JSON.");
  }

  private normalizeSuggestedTitle(value: string) {
    const normalized = this.truncateText(
      this.normalizeWhitespace(value).replace(/^["']|["']$/g, ""),
      80,
    );

    return normalized || null;
  }

  private normalizeSuggestedDescription(value: string) {
    const normalized = this.truncateText(value.trim(), 400);
    return normalized || null;
  }

  private humanizeFileName(fileName: string) {
    const name = basename(fileName, extname(fileName))
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return name || "Video clip";
  }

  private normalizeWhitespace(value: string) {
    return value.replace(/\s+/g, " ").trim();
  }

  private truncateText(value: string, maxLength: number) {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  private getErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }

    if (
      isRecord(error) &&
      typeof error.message === "string" &&
      error.message.trim()
    ) {
      return error.message.trim();
    }

    return "Unknown error";
  }

  private async planClipsWithGemini({
    jobId,
    sourcePath,
    originalFileName,
    durationSeconds,
    fallbackPlanConfig,
  }: {
    jobId: string;
    sourcePath: string;
    originalFileName: string;
    durationSeconds: number;
    fallbackPlanConfig: AutomaticClipPlanConfig;
  }): Promise<{
    clips: PlannedClipJob[];
    transcriptionSegments: TranscriptionSegment[];
  }> {
    let transcriptText = "";
    let transcriptionSegments: TranscriptionSegment[] = [];

    try {
      const transcription = await this.transcriptionService.transcribeFilePath({
        inputPath: sourcePath,
        originalName: originalFileName,
        profile: "longform",
        deleteAfter: false,
      });
      transcriptionSegments = transcription.segments;
      transcriptText = transcription.segments
        .map(
          (seg) =>
            `[${this.formatSecondsAsTimestamp(seg.start)}-${this.formatSecondsAsTimestamp(seg.end)}] ${this.normalizeWhitespace(seg.text)}`,
        )
        .filter((line) => line.trim())
        .join("\n");
    } catch {
      this.logger.warn(
        `Transcription unavailable for Gemini clip planning of ${originalFileName} — using duration-only prompt`,
      );
    }

    const promptLines = [
      "Select the best non-overlapping clips from this video to use as short-form content.",
      `Video: ${originalFileName}`,
      `Total duration: ${durationSeconds.toFixed(2)} seconds`,
      `Preferred clip count range: 1 to ${Math.max(2, fallbackPlanConfig.clipCount + 2)}`,
      `Hard maximum clip duration: ${fallbackPlanConfig.maxClipDurationSeconds} seconds`,
      "Clips do NOT need to be continuous — pick the best moments from anywhere in the video.",
      "Return raw JSON only with this exact shape:",
      '[{"startSeconds": number, "endSeconds": number}]',
      "Rules:",
      `- Return between 1 and ${Math.max(2, fallbackPlanConfig.clipCount + 2)} objects`,
      "- Clips must not overlap",
      `- Each clip must be between 5 and ${fallbackPlanConfig.maxClipDurationSeconds} seconds long`,
      `- startSeconds and endSeconds must be within [0, ${durationSeconds.toFixed(2)}]`,
      "- Prefer engaging, interesting, emotionally strong, or complete standalone moments",
      "- Return fewer clips when that produces a stronger overall result",
      "- Do not use markdown, backticks, or extra commentary",
    ];

    if (transcriptText) {
      promptLines.push("", "Transcript (with timestamps):", transcriptText);
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.geminiApiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptLines.join("\n") }] }],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(await this.readGeminiErrorMessage(response));
    }

    const payload: unknown = await response.json();
    const responseText = this.extractGeminiText(payload);
    const parsed = this.parseGeminiClipPlan(
      responseText,
      durationSeconds,
      fallbackPlanConfig.maxClipDurationSeconds,
    );

    if (parsed.length === 0) {
      throw new Error("Gemini returned no valid clip timestamps");
    }

    const clips: PlannedClipJob[] = parsed.map((clip, index) => ({
      ...clip,
      id: `${jobId}-${index + 1}`,
      label: `Clip ${index + 1}`,
      clipFileName: `clip-${index + 1}.mp4`,
    }));

    return { clips, transcriptionSegments };
  }

  private parseGeminiClipPlan(
    text: string,
    maxDurationSeconds: number,
    maxClipDurationSeconds: number,
  ): PlannedClip[] {
    const normalizedText = this.extractJsonPayload(text);
    const payload: unknown = JSON.parse(normalizedText);

    if (!Array.isArray(payload)) {
      throw new Error("Gemini returned invalid clip plan JSON");
    }

    return payload
      .filter(
        (item): item is { startSeconds: number; endSeconds: number } =>
          isRecord(item) &&
          typeof item.startSeconds === "number" &&
          typeof item.endSeconds === "number" &&
          item.endSeconds > item.startSeconds,
      )
      .map((item) => {
        const startSeconds = this.roundTo(Math.max(0, item.startSeconds), 2);
        const endSeconds = this.roundTo(
          Math.min(maxDurationSeconds, item.endSeconds),
          2,
        );
        const durationSeconds = this.roundTo(endSeconds - startSeconds, 2);
        return { startSeconds, endSeconds, durationSeconds };
      })
      .filter(
        (clip) =>
          clip.durationSeconds >= 1 &&
          clip.durationSeconds <= maxClipDurationSeconds + 1,
      );
  }

  private formatSecondsAsTimestamp(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  private getAutomaticClipPlanConfig(
    totalDurationSeconds: number,
  ): AutomaticClipPlanConfig {
    const normalizedDuration = Math.max(totalDurationSeconds, 1);
    const clipCount = Math.min(
      6,
      Math.max(1, Math.round(normalizedDuration / 60)),
    );
    const maxClipDurationSeconds = Math.min(
      60,
      Math.max(
        20,
        this.roundTo(normalizedDuration / Math.max(clipCount, 1), 2),
      ),
    );

    return {
      clipCount,
      maxClipDurationSeconds,
    };
  }

  private planClips({
    totalDurationSeconds,
    clipCount,
    maxClipDurationSeconds,
  }: {
    totalDurationSeconds: number;
    clipCount: number;
    maxClipDurationSeconds: number;
  }) {
    if (clipCount === 1) {
      const durationSeconds = Math.min(
        totalDurationSeconds,
        maxClipDurationSeconds,
      );
      return [
        {
          startSeconds: 0,
          endSeconds: durationSeconds,
          durationSeconds,
        },
      ] satisfies PlannedClip[];
    }

    const durationSeconds = Math.min(
      maxClipDurationSeconds,
      totalDurationSeconds / clipCount,
    );
    const sequentialCoverage = durationSeconds * clipCount;

    if (sequentialCoverage >= totalDurationSeconds - 0.25) {
      return Array.from({ length: clipCount }, (_, index) => {
        const startSeconds = index * durationSeconds;
        const endSeconds = Math.min(
          totalDurationSeconds,
          startSeconds + durationSeconds,
        );
        return {
          startSeconds: this.roundTo(startSeconds, 2),
          endSeconds: this.roundTo(endSeconds, 2),
          durationSeconds: this.roundTo(endSeconds - startSeconds, 2),
        };
      });
    }

    const lastStart = totalDurationSeconds - durationSeconds;
    return Array.from({ length: clipCount }, (_, index) => {
      const ratio = clipCount === 1 ? 0 : index / (clipCount - 1);
      const startSeconds = lastStart * ratio;
      const endSeconds = Math.min(
        totalDurationSeconds,
        startSeconds + durationSeconds,
      );
      return {
        startSeconds: this.roundTo(startSeconds, 2),
        endSeconds: this.roundTo(endSeconds, 2),
        durationSeconds: this.roundTo(endSeconds - startSeconds, 2),
      };
    });
  }

  private async renderClip({
    inputPath,
    outputPath,
    startSeconds,
    durationSeconds,
    targetClipSizeMb,
    ffmpegBinaryPath,
  }: {
    ffmpegBinaryPath: string;
    inputPath: string;
    outputPath: string;
    startSeconds: number;
    durationSeconds: number;
    targetClipSizeMb?: number;
  }) {
    const shortVideoFilter =
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";

    const args = [
      "-y",
      "-ss",
      startSeconds.toFixed(2),
      "-i",
      inputPath,
      "-t",
      durationSeconds.toFixed(2),
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-vf",
      shortVideoFilter,
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ];

    if (targetClipSizeMb) {
      const audioBitrateKbps = 128;
      const totalBitrateKbps = Math.max(
        audioBitrateKbps + 200,
        Math.floor((targetClipSizeMb * 8192) / durationSeconds),
      );
      const videoBitrateKbps = Math.max(
        200,
        totalBitrateKbps - audioBitrateKbps,
      );

      args.push(
        "-c:a",
        "aac",
        "-b:a",
        `${audioBitrateKbps}k`,
        "-b:v",
        `${videoBitrateKbps}k`,
        "-maxrate",
        `${videoBitrateKbps}k`,
        "-bufsize",
        `${videoBitrateKbps * 2}k`,
      );
    } else {
      args.push("-c:a", "aac", "-b:a", "128k", "-crf", "23");
    }

    args.push(outputPath);

    const { stderr } = await execFileAsync(ffmpegBinaryPath, args, {
      encoding: "utf8",
    });

    if (stderr) {
      console.log(stderr);
    }
  }

  private roundTo(value: number, precision: number) {
    const multiplier = 10 ** precision;
    return Math.round(value * multiplier) / multiplier;
  }

  private async bossCallGemini(promptText: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.geminiModel)}:generateContent`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
    });

    let lastError: Error = new Error("Gemini request failed.");
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const delayMs = 3000 * attempt;
        this.logger.warn(`Gemini overloaded, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/4)...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.geminiApiKey,
        },
        body,
      });
      if (response.ok) {
        return this.extractGeminiText(await response.json());
      }
      const msg = await this.readGeminiErrorMessage(response);
      lastError = new Error(msg);
      const isRetryable = response.status === 503 || response.status === 429 ||
        msg.toLowerCase().includes("demand") ||
        msg.toLowerCase().includes("overload") ||
        msg.toLowerCase().includes("unavailable");
      if (!isRetryable) {
        throw lastError;
      }
    }
    throw lastError;
  }

  private findSourceFile(jobId: string): string {
    const jobDir = this.getJobDirectory(jobId);
    const extensions = [".mp4", ".mov", ".mkv", ".webm", ".avi"];
    for (const ext of extensions) {
      const candidate = join(jobDir, `source${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    throw new BadRequestException(`Source file not found for job ${jobId}.`);
  }

  private async bossGeminiPlanChapters({
    prompt,
    transcriptText,
    durationSeconds,
    settings,
  }: {
    prompt: string;
    transcriptText: string;
    durationSeconds: number;
    settings: BossPlanningSettings;
  }): Promise<BossChapter[]> {
    const promptLines = [
      "You are a video editor. Split this video into consecutive named chapters based on the user's instructions.",
      `Total duration: ${durationSeconds.toFixed(2)} seconds`,
      `User's cut instructions: "${prompt}"`,
      "",
      "Return raw JSON only, no markdown:",
      '[{"startSeconds": number, "endSeconds": number, "title": "string"}]',
      "",
      "Rules:",
      `- Chapters must be consecutive and together span the ENTIRE video from 0 to ${durationSeconds.toFixed(2)}`,
      `- Minimum chapter duration: ${settings.minChapterDurationSeconds} seconds`,
      `- Return ${settings.minChapters} to ${settings.maxChapters} chapters`,
      "- Title: descriptive, under 80 chars",
      "- No overlaps, no gaps between chapters",
    ];

    if (transcriptText) {
      promptLines.push("", "Transcript (timestamps [MM:SS-MM:SS]):", transcriptText);
    }

    const text = await this.bossCallGemini(promptLines.join("\n"));
    return this.parseChapterPlan(text, durationSeconds, settings);
  }

  private parseChapterPlan(
    text: string,
    durationSeconds: number,
    settings: BossPlanningSettings,
  ): BossChapter[] {
    try {
      const json = this.extractJsonPayload(text);
      const payload: unknown = JSON.parse(json);

      if (!Array.isArray(payload)) return [];

      return payload
        .filter(
          (item): item is { startSeconds: number; endSeconds: number; title: string } =>
            isRecord(item) &&
            typeof item.startSeconds === "number" &&
            typeof item.endSeconds === "number" &&
            typeof item.title === "string" &&
            item.endSeconds > item.startSeconds,
        )
        .map((item) => ({
          startSeconds: this.roundTo(Math.max(0, item.startSeconds), 2),
          endSeconds: this.roundTo(Math.min(durationSeconds, item.endSeconds), 2),
          title: this.normalizeWhitespace(item.title).slice(0, 80) || "Section",
        }))
        .filter(
          (item) =>
            item.endSeconds - item.startSeconds >=
            Math.max(5, settings.minChapterDurationSeconds - 2),
        );
    } catch {
      return [];
    }
  }

  private async bossGeminiPlanShorts({
    longerSegments,
    transcriptSegments,
    durationSeconds,
    settings,
  }: {
    longerSegments: BossChapter[];
    transcriptSegments: TranscriptionSegment[];
    durationSeconds: number;
    settings: BossPlanningSettings;
  }): Promise<BossShort[]> {
    const segmentPayloads = longerSegments.map((seg, i) => ({
      index: i,
      title: seg.title,
      startSeconds: seg.startSeconds,
      endSeconds: seg.endSeconds,
      transcript:
        this.getTranscriptSnippetForRange({
          segments: transcriptSegments,
          startSeconds: seg.startSeconds,
          endSeconds: seg.endSeconds,
        }) || "(no transcript available)",
    }));

    const promptLines = [
      `You are a TikTok content strategist. From the video segments below, identify the ${settings.minShortsPerSegment}-${settings.maxShortsPerSegment} best short-form moments per segment.`,
      "",
      "Each short must have:",
      `- Duration: ${settings.minShortDurationSeconds}-${settings.maxShortDurationSeconds} seconds`,
      "- Absolute timestamps from the ORIGINAL video (not relative to the segment)",
      "- Title: exactly 3-5 words, punchy (avoid generic filler like 'amazing moment')",
      "- Description: under 300 chars, conversational, end with 3-5 relevant hashtags",
      "",
      "Return raw JSON only (no markdown, no commentary):",
      '[{"segmentIndex": 0, "startSeconds": 0, "endSeconds": 60, "title": "3-5 words", "description": "caption #tag1 #tag2"}]',
      "",
      "Segments:",
      JSON.stringify(segmentPayloads, null, 2),
    ];

    try {
      const text = await this.bossCallGemini(promptLines.join("\n"));
      return this.parseShortsPlan(
        text,
        durationSeconds,
        settings,
        longerSegments.length,
      );
    } catch (error) {
      this.logger.warn(
        `Boss shorts planning failed: ${this.getErrorMessage(error)}`,
      );
      return [];
    }
  }

  private parseShortsPlan(
    text: string,
    durationSeconds: number,
    settings: BossPlanningSettings,
    segmentCount: number,
  ): BossShort[] {
    try {
      const json = this.extractJsonPayload(text);
      const payload: unknown = JSON.parse(json);

      if (!Array.isArray(payload)) return [];

      const parsed = payload
        .filter(
          (item): item is {
            segmentIndex: number;
            startSeconds: number;
            endSeconds: number;
            title: string;
            description: string;
          } =>
            isRecord(item) &&
            typeof item.segmentIndex === "number" &&
            typeof item.startSeconds === "number" &&
            typeof item.endSeconds === "number" &&
            typeof item.title === "string" &&
            typeof item.description === "string" &&
            item.endSeconds > item.startSeconds,
        )
        .map((item) => ({
            startSeconds: this.roundTo(Math.max(0, item.startSeconds), 2),
            endSeconds: this.roundTo(Math.min(durationSeconds, item.endSeconds), 2),
            segmentIndex: Math.round(item.segmentIndex),
            title: this.normalizeWhitespace(item.title).slice(0, 60) || "Short Clip",
            description: item.description.trim().slice(0, 300),
          }))
        .filter((item) => {
          const dur = item.endSeconds - item.startSeconds;
          return (
            dur >= settings.minShortDurationSeconds &&
            dur <= settings.maxShortDurationSeconds + 2
          );
        });

      const grouped = new Map<number, BossShort[]>();
      for (const item of parsed) {
        if (item.segmentIndex < 0 || item.segmentIndex >= segmentCount) continue;

        const current = grouped.get(item.segmentIndex) ?? [];
        if (current.length >= settings.maxShortsPerSegment) continue;
        current.push({
          startSeconds: item.startSeconds,
          endSeconds: item.endSeconds,
          title: item.title,
          description: item.description,
        });
        grouped.set(item.segmentIndex, current);
      }

      return [...grouped.values()].flat();
    } catch {
      return [];
    }
  }

  private getTranscriptSnippetForRange({
    segments,
    startSeconds,
    endSeconds,
  }: {
    segments: TranscriptionSegment[];
    startSeconds: number;
    endSeconds: number;
  }): string {
    const text = segments
      .filter((seg) => seg.end > startSeconds && seg.start < endSeconds)
      .map((seg) => this.normalizeWhitespace(seg.text))
      .filter(Boolean)
      .join(" ");

    return this.truncateText(this.normalizeWhitespace(text), 2000);
  }

  private async bossRenderClipCopy({
    ffmpegBinaryPath,
    inputPath,
    outputPath,
    startSeconds,
    durationSeconds,
  }: {
    ffmpegBinaryPath: string;
    inputPath: string;
    outputPath: string;
    startSeconds: number;
    durationSeconds: number;
  }): Promise<void> {
    const args = [
      "-y",
      "-ss",
      startSeconds.toFixed(2),
      "-i",
      inputPath,
      "-t",
      durationSeconds.toFixed(2),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      outputPath,
    ];

    const { stderr } = await execFileAsync(ffmpegBinaryPath, args, {
      encoding: "utf8",
    });

    if (stderr) {
      this.logger.debug(stderr);
    }
  }

  private async bossGeminiPlanHighlights({
    transcriptText,
    durationSeconds,
    targetSeconds,
    focus,
  }: {
    transcriptText: string;
    durationSeconds: number;
    targetSeconds: number;
    focus?: string;
  }): Promise<BossHighlight[]> {
    const targetMinutes = (targetSeconds / 60).toFixed(1);
    const promptLines = [
      "You are a video editor creating a condensed highlight reel that summarizes a long video.",
      `The source video is ${durationSeconds.toFixed(0)} seconds long.`,
      `Select the most important, interesting, and self-contained moments so the COMBINED duration of all selected clips is as close as possible to ${targetSeconds.toFixed(0)} seconds (about ${targetMinutes} minutes).`,
      focus ? `Focus especially on: "${focus}"` : "",
      "",
      "Return raw JSON only, no markdown:",
      '[{"startSeconds": number, "endSeconds": number, "reason": "string"}]',
      "",
      "Rules:",
      "- Segments MUST be in chronological order and must NOT overlap.",
      `- Spread the selections across the ENTIRE video from 0 to ${durationSeconds.toFixed(0)} seconds, not just the beginning.`,
      "- Each segment should be a coherent moment, ideally 8 to 90 seconds long, and never shorter than 4 seconds.",
      `- The combined duration of all segments should total approximately ${targetSeconds.toFixed(0)} seconds. Do not greatly exceed it.`,
      "- Cut on natural pauses using the transcript timestamps, and prefer complete sentences or thoughts.",
      "- reason: a short phrase explaining why the moment matters.",
      "",
      "Transcript (each line is [MM:SS-MM:SS] spoken text; minutes may exceed 59 for long videos):",
      transcriptText || "(no transcript available)",
    ].filter(Boolean);

    const text = await this.bossCallGemini(promptLines.join("\n"));
    return this.parseHighlightPlan(text, durationSeconds);
  }

  private parseHighlightPlan(
    text: string,
    durationSeconds: number,
  ): BossHighlight[] {
    try {
      const json = this.extractJsonPayload(text);
      const payload: unknown = JSON.parse(json);

      if (!Array.isArray(payload)) return [];

      const cleaned = payload
        .filter(
          (item): item is { startSeconds: number; endSeconds: number; reason?: unknown } =>
            isRecord(item) &&
            typeof item.startSeconds === "number" &&
            typeof item.endSeconds === "number" &&
            item.endSeconds > item.startSeconds,
        )
        .map((item) => ({
          startSeconds: this.roundTo(Math.max(0, item.startSeconds), 2),
          endSeconds: this.roundTo(Math.min(durationSeconds, item.endSeconds), 2),
          reason:
            typeof item.reason === "string"
              ? this.normalizeWhitespace(item.reason).slice(0, 200)
              : "",
        }))
        .filter((item) => item.endSeconds - item.startSeconds >= 2)
        .sort((a, b) => a.startSeconds - b.startSeconds);

      // Clamp any overlaps so concatenation stays chronological and clean.
      const nonOverlapping: BossHighlight[] = [];
      let lastEnd = 0;
      for (const item of cleaned) {
        const startSeconds = this.roundTo(Math.max(item.startSeconds, lastEnd), 2);
        if (item.endSeconds - startSeconds >= 2) {
          nonOverlapping.push({
            startSeconds,
            endSeconds: item.endSeconds,
            reason: item.reason,
          });
          lastEnd = item.endSeconds;
        }
      }

      return nonOverlapping;
    } catch {
      return [];
    }
  }

  private async bossRenderSegmentReencode({
    ffmpegBinaryPath,
    inputPath,
    outputPath,
    startSeconds,
    durationSeconds,
  }: {
    ffmpegBinaryPath: string;
    inputPath: string;
    outputPath: string;
    startSeconds: number;
    durationSeconds: number;
  }): Promise<void> {
    // Keep the source aspect ratio but normalize codec/pixel/audio params so
    // all segments are concat-compatible.
    const args = [
      "-y",
      "-ss",
      startSeconds.toFixed(2),
      "-i",
      inputPath,
      "-t",
      durationSeconds.toFixed(2),
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outputPath,
    ];

    const { stderr } = await execFileAsync(ffmpegBinaryPath, args, {
      encoding: "utf8",
    });

    if (stderr) {
      this.logger.debug(stderr);
    }
  }

  private async concatSegments({
    ffmpegBinaryPath,
    jobDir,
    segmentPaths,
    outputPath,
  }: {
    ffmpegBinaryPath: string;
    jobDir: string;
    segmentPaths: string[];
    outputPath: string;
  }): Promise<void> {
    const listPath = join(jobDir, "summary-concat.txt");
    const listContent = segmentPaths
      .map((segPath) => `file '${segPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    writeFileSync(listPath, listContent, "utf8");

    const args = [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ];

    try {
      const { stderr } = await execFileAsync(ffmpegBinaryPath, args, {
        encoding: "utf8",
      });
      if (stderr) {
        this.logger.debug(stderr);
      }
    } finally {
      try {
        unlinkSync(listPath);
      } catch {
        // best-effort cleanup of the concat manifest
      }
    }
  }

  private async openFolderInExplorer(folderPath: string) {
    const explorerPath = join(
      process.env.WINDIR ?? "C:\\WINDOWS",
      "explorer.exe",
    );

    try {
      await execFileAsync(explorerPath, [folderPath], {
        windowsHide: true,
      });
      return;
    } catch {
      await execFileAsync("cmd.exe", ["/c", "start", "", folderPath], {
        windowsHide: true,
      });
    }
  }
}

export function getUploadDirectory() {
  mkdirSync(uploadsDirectory, { recursive: true });
  return uploadsDirectory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
