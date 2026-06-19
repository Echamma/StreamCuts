import type { SocialCopy } from "@/socials/types";

export const LONG_TO_SHORT_API_BASE =
	process.env.NEXT_PUBLIC_LONG_TO_SHORT_API_URL ?? "http://localhost:4000";

export type LongToShortClip = {
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

export type LongToShortResult = {
	jobId: string;
	originalFileName: string;
	sourceDurationSeconds: number;
	clipCount: number;
	targetClipSizeMb: number | null;
	clips: LongToShortClip[];
};

// ── Boss pipeline types ────────────────────────────────────────────────

export type BossTranscriptSegment = { start: number; end: number; text: string };
export type BossChapter = { startSeconds: number; endSeconds: number; title: string };
export type BossShort = {
	startSeconds: number;
	endSeconds: number;
	title: string;
	description: string;
};
export type BossRenderedClip = { downloadUrl: string; title: string };
export type BossRenderedShort = { downloadUrl: string; title: string; description: string };

export type BossUploadResult = {
	jobId: string;
	sourceDurationSeconds: number;
	sourceFileName: string;
};

export type BossTranscribeResult = { segments: BossTranscriptSegment[] };

export type BossPlanCutsResult = {
	longerSegments: BossChapter[];
	shorts: BossShort[];
};

export type BossRenderResult = {
	longerVideos: BossRenderedClip[];
	shorts: BossRenderedShort[];
};

// ── Boss pipeline API calls ────────────────────────────────────────────

export async function bossSaveUpload({ video }: { video: File }): Promise<BossUploadResult> {
	const formData = new FormData();
	formData.set("video", video);

	const response = await fetch(resolveLongToShortUrl({ path: "/api/boss/upload" }), {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	const payload: unknown = await response.json();
	if (
		!isRecord(payload) ||
		typeof payload.jobId !== "string" ||
		typeof payload.sourceDurationSeconds !== "number" ||
		typeof payload.sourceFileName !== "string"
	) {
		throw new Error("Backend returned an invalid upload payload.");
	}

	return {
		jobId: payload.jobId,
		sourceDurationSeconds: payload.sourceDurationSeconds,
		sourceFileName: payload.sourceFileName,
	};
}

export async function bossTranscribe({
	jobId,
}: {
	jobId: string;
}): Promise<BossTranscribeResult> {
	const response = await fetch(resolveLongToShortUrl({ path: "/api/boss/transcribe" }), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jobId }),
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.segments)) {
		throw new Error("Backend returned an invalid transcribe payload.");
	}

	const segments: BossTranscriptSegment[] = (payload.segments as unknown[])
		.filter(
			(s): s is { start: number; end: number; text: string } =>
				isRecord(s) &&
				typeof s.start === "number" &&
				typeof s.end === "number" &&
				typeof s.text === "string",
		)
		.map((s) => ({ start: s.start, end: s.end, text: s.text }));

	return { segments };
}

export async function bossPlanCuts({
	jobId,
	prompt,
	segments,
	durationSeconds,
}: {
	jobId: string;
	prompt: string;
	segments: BossTranscriptSegment[];
	durationSeconds: number;
}): Promise<BossPlanCutsResult> {
	const response = await fetch(resolveLongToShortUrl({ path: "/api/boss/plan-cuts" }), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jobId, prompt, segments, durationSeconds }),
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	const payload: unknown = await response.json();
	if (
		!isRecord(payload) ||
		!Array.isArray(payload.longerSegments) ||
		!Array.isArray(payload.shorts)
	) {
		throw new Error("Backend returned an invalid plan-cuts payload.");
	}

	return {
		longerSegments: payload.longerSegments as BossChapter[],
		shorts: payload.shorts as BossShort[],
	};
}

export async function bossRender({
	jobId,
	longerSegments,
	shorts,
}: {
	jobId: string;
	longerSegments: BossChapter[];
	shorts: BossShort[];
}): Promise<BossRenderResult> {
	const response = await fetch(resolveLongToShortUrl({ path: "/api/boss/render" }), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jobId, longerSegments, shorts }),
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	const payload: unknown = await response.json();
	if (
		!isRecord(payload) ||
		!Array.isArray(payload.longerVideos) ||
		!Array.isArray(payload.shorts)
	) {
		throw new Error("Backend returned an invalid render payload.");
	}

	return {
		longerVideos: payload.longerVideos as BossRenderedClip[],
		shorts: payload.shorts as BossRenderedShort[],
	};
}

// ── Health / existing ──────────────────────────────────────────────────

export async function checkLongToShortHealth() {
	const response = await fetch(resolveLongToShortUrl({ path: "/api/health" }));

	if (!response.ok) {
		throw new Error("Backend health check failed.");
	}

	return parseHealthResponse({ payload: await response.json() });
}

export async function processLongToShort({
	video,
	targetClipSizeMb,
	transcript,
}: {
	video: File;
	targetClipSizeMb?: number;
	transcript?: string;
}) {
	const formData = new FormData();
	formData.set("video", video);

	if (targetClipSizeMb != null) {
		formData.set("targetClipSizeMb", String(targetClipSizeMb));
	}

	if (transcript) {
		formData.set("transcript", transcript);
	}

	const response = await fetch(
		resolveLongToShortUrl({ path: "/api/long-to-short/process" }),
		{
			method: "POST",
			body: formData,
		},
	);

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	return parseLongToShortResult({ payload: await response.json() });
}

export async function revealLongToShortFolder({ jobId }: { jobId: string }) {
	const response = await fetch(
		resolveLongToShortUrl({
			path: `/api/long-to-short/jobs/${encodeURIComponent(jobId)}/reveal-folder`,
		}),
		{
			method: "POST",
		},
	);

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	return parseRevealFolderResult({ payload: await response.json() });
}

export async function openExportsFolder() {
	const response = await fetch(
		resolveLongToShortUrl({ path: "/api/system/open-exports-folder" }),
		{
			method: "POST",
		},
	);

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	return parseOpenExportsFolderResult({ payload: await response.json() });
}

export function resolveLongToShortUrl({ path }: { path: string }) {
	if (/^https?:\/\//.test(path)) {
		return path;
	}

	return new URL(path, LONG_TO_SHORT_API_BASE).toString();
}

async function readErrorMessage({ response }: { response: Response }) {
	try {
		const payload: unknown = await response.json();

		if (!isRecord(payload)) {
			return "The backend request failed.";
		}

		const { message } = payload;
		if (
			Array.isArray(message) &&
			message.every((item) => typeof item === "string")
		) {
			return message.join(" ");
		}

		return typeof message === "string"
			? message
			: "The backend request failed.";
	} catch {
		return "The backend request failed.";
	}
}

function parseHealthResponse({ payload }: { payload: unknown }) {
	if (
		isRecord(payload) &&
		typeof payload.ok === "boolean" &&
		typeof payload.service === "string"
	) {
		return {
			ok: payload.ok,
			service: payload.service,
		};
	}

	throw new Error("Backend health check returned an invalid payload.");
}

function parseLongToShortResult({
	payload,
}: {
	payload: unknown;
}): LongToShortResult {
	if (!isRecord(payload) || !Array.isArray(payload.clips)) {
		throw new Error("Backend returned an invalid clip payload.");
	}

	const clips = payload.clips
		.map((clip) => parseLongToShortClip({ payload: clip }))
		.filter((clip): clip is LongToShortClip => clip !== null);

	if (
		typeof payload.jobId !== "string" ||
		typeof payload.originalFileName !== "string" ||
		typeof payload.sourceDurationSeconds !== "number" ||
		typeof payload.clipCount !== "number" ||
		(payload.targetClipSizeMb !== null &&
			payload.targetClipSizeMb !== undefined &&
			typeof payload.targetClipSizeMb !== "number")
	) {
		throw new Error("Backend returned an invalid clip payload.");
	}

	const targetClipSizeMb =
		typeof payload.targetClipSizeMb === "number"
			? payload.targetClipSizeMb
			: null;

	return {
		jobId: payload.jobId,
		originalFileName: payload.originalFileName,
		sourceDurationSeconds: payload.sourceDurationSeconds,
		clipCount: payload.clipCount,
		targetClipSizeMb,
		clips,
	};
}

function parseLongToShortClip({
	payload,
}: {
	payload: unknown;
}): LongToShortClip | null {
	if (
		!isRecord(payload) ||
		typeof payload.id !== "string" ||
		typeof payload.label !== "string" ||
		typeof payload.startSeconds !== "number" ||
		typeof payload.endSeconds !== "number" ||
		typeof payload.durationSeconds !== "number" ||
		(payload.estimatedSourceSizeMb !== null &&
			payload.estimatedSourceSizeMb !== undefined &&
			typeof payload.estimatedSourceSizeMb !== "number") ||
		typeof payload.renderedSizeMb !== "number" ||
		typeof payload.downloadUrl !== "string" ||
		parseSocialCopy({ payload: payload.socialCopy }) === null
	) {
		return null;
	}

	const socialCopy = parseSocialCopy({ payload: payload.socialCopy });
	if (!socialCopy) {
		return null;
	}

	const estimatedSourceSizeMb =
		typeof payload.estimatedSourceSizeMb === "number"
			? payload.estimatedSourceSizeMb
			: null;

	return {
		id: payload.id,
		label: payload.label,
		startSeconds: payload.startSeconds,
		endSeconds: payload.endSeconds,
		durationSeconds: payload.durationSeconds,
		estimatedSourceSizeMb,
		renderedSizeMb: payload.renderedSizeMb,
		downloadUrl: payload.downloadUrl,
		socialCopy,
	};
}

function parseSocialCopy({ payload }: { payload: unknown }): SocialCopy | null {
	if (
		!isRecord(payload) ||
		payload.platform !== "tiktok" ||
		(payload.provider !== "gemini" && payload.provider !== "fallback") ||
		typeof payload.title !== "string" ||
		typeof payload.description !== "string"
	) {
		return null;
	}

	return {
		platform: payload.platform,
		provider: payload.provider,
		title: payload.title,
		description: payload.description,
	};
}

function parseRevealFolderResult({ payload }: { payload: unknown }) {
	if (
		!isRecord(payload) ||
		typeof payload.ok !== "boolean" ||
		typeof payload.jobId !== "string" ||
		typeof payload.folderPath !== "string"
	) {
		throw new Error("Backend returned an invalid reveal-folder payload.");
	}

	return {
		ok: payload.ok,
		jobId: payload.jobId,
		folderPath: payload.folderPath,
	};
}

function parseOpenExportsFolderResult({ payload }: { payload: unknown }) {
	if (
		!isRecord(payload) ||
		typeof payload.ok !== "boolean" ||
		typeof payload.folderPath !== "string"
	) {
		throw new Error("Backend returned an invalid exports-folder payload.");
	}

	return {
		ok: payload.ok,
		folderPath: payload.folderPath,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
