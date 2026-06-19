import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const MAX_INLINE_MEDIA_BYTES = 35 * 1024 * 1024;

export type BossCueSuggestionsResult = {
  rawText: string;
  cues: number[];
};

export type BossSegmentMetadataResult = {
  title: string;
  description: string;
  warning: string | null;
};

export type BossShortPlanResult = {
  startSec: number;
  endSec: number;
  viralScore: number;
  reason: string;
  title: string;
  description: string;
  warning: string | null;
};

@Injectable()
export class BossService {
  private readonly geminiApiKey = (process.env.GEMINI_API_KEY ?? "").trim();
  private readonly geminiModel =
    (process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL).trim() ||
    DEFAULT_GEMINI_MODEL;

  private getApiKey(): string {
    if (!this.geminiApiKey) {
      throw new InternalServerErrorException(
        "GEMINI_API_KEY is not configured. Add it to backend/long-to-short/.env.",
      );
    }
    return this.geminiApiKey;
  }

  async requestCueSuggestions({
    durationSeconds,
    userPrompt,
  }: {
    durationSeconds: number;
    userPrompt: string;
  }): Promise<BossCueSuggestionsResult> {
    const systemInstruction =
      "You are a video editor assistant. " +
      `The user has uploaded a video of duration ${durationSeconds.toFixed(2)} seconds. ` +
      "When the user describes where to cut, respond with a JSON array of cue timestamps in seconds, " +
      "for example [330, 1420, 3600]. Always include the JSON array in your reply even when explaining your reasoning.";

    const rawText = await this.callGemini({
      systemInstruction,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: { type: "ARRAY", items: { type: "NUMBER" } },
        temperature: 0.4,
      },
    });

    return { rawText, cues: this.parseCueArray(rawText) };
  }

  async generateSegmentMetadata({
    mediaBuffer,
    mimeType,
    index,
    total,
    durationSeconds,
  }: {
    mediaBuffer: Buffer;
    mimeType: string;
    index: number;
    total: number;
    durationSeconds: number;
  }): Promise<BossSegmentMetadataResult> {
    const parts: unknown[] = [];
    let warning: string | null = null;

    if (mediaBuffer.length <= MAX_INLINE_MEDIA_BYTES) {
      parts.push({
        inlineData: {
          data: mediaBuffer.toString("base64"),
          mimeType: mimeType || "video/mp4",
        },
      });
    } else {
      warning =
        "The clip is too large for Gemini inline media input, so this response was generated from prompt context only.";
    }

    parts.push({
      text:
        `This is segment ${index} of ${total} from a video. Duration: ${durationSeconds.toFixed(2)}s. ` +
        "Generate: (1) a YouTube video title under 100 characters, (2) a 2-sentence SEO description, " +
        '(3) an optional warning string if the clip context is incomplete, otherwise null. Respond as JSON: { title: string, description: string, warning: string | null }',
    });

    const rawText = await this.callGemini({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            description: { type: "STRING" },
            warning: { type: "STRING", nullable: true },
          },
          required: ["title", "description"],
        },
        temperature: 0.4,
      },
    });

    const data = this.parseJson(rawText) as Record<string, unknown>;
    return {
      title: (typeof data.title === "string" ? data.title : "").trim(),
      description: (typeof data.description === "string" ? data.description : "").trim(),
      warning: (typeof data.warning === "string" ? data.warning : null) ?? warning,
    };
  }

  async generateShortPlan({
    mediaBuffer,
    mimeType,
    durationSeconds,
  }: {
    mediaBuffer: Buffer;
    mimeType: string;
    durationSeconds: number;
  }): Promise<BossShortPlanResult> {
    const parts: unknown[] = [];
    let warning: string | null = null;

    if (mediaBuffer.length <= MAX_INLINE_MEDIA_BYTES) {
      parts.push({
        inlineData: {
          data: mediaBuffer.toString("base64"),
          mimeType: mimeType || "video/mp4",
        },
      });
    } else {
      warning =
        "The clip is too large for Gemini inline media input, so this response was generated from prompt context only.";
    }

    parts.push({
      text:
        `Watch this video clip (${durationSeconds.toFixed(2)}s). ` +
        "Find the single best moment to go viral as a YouTube Short. " +
        "The short must be under 90 seconds — pick the natural length of the best moment and do not pad to fill 90 seconds. " +
        "Respond as JSON only, including warning as null unless there is an input limitation.",
    });

    const rawText = await this.callGemini({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            startSec: { type: "NUMBER" },
            endSec: { type: "NUMBER" },
            viralScore: { type: "NUMBER" },
            reason: { type: "STRING" },
            title: { type: "STRING" },
            description: { type: "STRING" },
            warning: { type: "STRING", nullable: true },
          },
          required: ["startSec", "endSec", "viralScore", "reason", "title", "description"],
        },
        temperature: 0.4,
      },
    });

    const data = this.parseJson(rawText) as Record<string, unknown>;
    const startSec = Math.max(0, Number(data.startSec) || 0);
    const hardEndCap = Math.min(durationSeconds, startSec + 89);
    const requestedEnd = Number(data.endSec) || hardEndCap;
    const endSec = Math.max(startSec + 1, Math.min(requestedEnd, hardEndCap));

    return {
      startSec,
      endSec,
      viralScore: Math.max(0, Math.min(100, Number(data.viralScore) || 0)),
      reason: (typeof data.reason === "string" ? data.reason : "").trim(),
      title: (typeof data.title === "string" ? data.title : "").trim(),
      description: (typeof data.description === "string" ? data.description : "").trim(),
      warning: (typeof data.warning === "string" ? data.warning : null) ?? warning,
    };
  }

  async generateSubtitlesSrt({
    mediaBuffer,
    mimeType,
  }: {
    mediaBuffer: Buffer;
    mimeType: string;
  }): Promise<string> {
    if (mediaBuffer.length > MAX_INLINE_MEDIA_BYTES) {
      throw new BadRequestException(
        "The clip is too large for Gemini inline subtitle transcription. Create a smaller segment first.",
      );
    }

    return this.callGemini({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                data: mediaBuffer.toString("base64"),
                mimeType: mimeType || "video/mp4",
              },
            },
            {
              text:
                "Transcribe this audio to SRT subtitle format. " +
                "Use short phrases of 5-8 words max per subtitle block. Include accurate timestamps.",
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.2 },
    });
  }

  private async callGemini({
    systemInstruction,
    contents,
    generationConfig,
  }: {
    systemInstruction?: string;
    contents: unknown[];
    generationConfig?: Record<string, unknown>;
  }): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.geminiModel,
    )}:generateContent`;

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (generationConfig) {
      body.generationConfig = generationConfig;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.getApiKey(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new InternalServerErrorException(
        await this.readGeminiError(response),
      );
    }

    return this.extractText(await response.json());
  }

  private async readGeminiError(response: Response): Promise<string> {
    const fallback = `Gemini request failed with status ${response.status}.`;
    try {
      const payload: unknown = JSON.parse(await response.text());
      if (
        isRecord(payload) &&
        isRecord(payload.error) &&
        typeof payload.error.message === "string"
      ) {
        return payload.error.message;
      }
    } catch {
      // ignore
    }
    return fallback;
  }

  private extractText(payload: unknown): string {
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
      throw new InternalServerErrorException(
        "Gemini returned an invalid response payload.",
      );
    }

    const candidate = payload.candidates.find((item) => isRecord(item));
    if (
      !candidate ||
      !isRecord(candidate.content) ||
      !Array.isArray(candidate.content.parts)
    ) {
      throw new InternalServerErrorException("Gemini returned no content.");
    }

    const text = candidate.content.parts
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("\n")
      .trim();

    if (!text) {
      throw new InternalServerErrorException(
        "Gemini returned an empty response.",
      );
    }

    return text;
  }

  private parseJson(rawText: string): unknown {
    const trimmed = rawText.trim();
    if (!trimmed) {
      throw new InternalServerErrorException(
        "Gemini returned an empty response.",
      );
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      const match = trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      if (!match) {
        throw new InternalServerErrorException(
          "Gemini returned malformed JSON.",
        );
      }
      return JSON.parse(match[0]);
    }
  }

  private parseCueArray(rawText: string): number[] {
    try {
      const data = this.parseJson(rawText);
      if (!Array.isArray(data)) return [];
      return data
        .filter(
          (item): item is number =>
            typeof item === "number" && Number.isFinite(item),
        )
        .map(Number);
    } catch {
      return [];
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
