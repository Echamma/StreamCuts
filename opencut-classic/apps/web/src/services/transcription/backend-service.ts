import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/transcription/types";

const TRANSCRIPTION_API_BASE =
	process.env.NEXT_PUBLIC_LONG_TO_SHORT_API_URL ?? "http://localhost:4000";

export interface BackendModelStatus {
	id: string;
	downloaded: boolean;
}

export interface BackendModelListResult {
	default: string | null;
	active: string | null;
	models: BackendModelStatus[];
}

export async function transcribeWithBackend({
	audioBlob,
	language,
	model,
}: {
	audioBlob: Blob;
	language?: Exclude<TranscriptionLanguage, "auto">;
	model?: string;
}): Promise<TranscriptionResult> {
	const formData = new FormData();
	formData.set("audio", audioBlob, "timeline.wav");

	if (language) {
		formData.set("language", language);
	}

	if (model) {
		formData.set("model", model);
	}

	const response = await fetch(
		resolveTranscriptionUrl("/api/transcription/transcribe"),
		{
			method: "POST",
			body: formData,
		},
	);

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	return parseTranscriptionResult({ payload: await response.json() });
}

export async function fetchTranscriptionModelStatus({
	models,
}: {
	models: string[];
}): Promise<BackendModelListResult> {
	const response = await fetch(
		resolveTranscriptionUrl("/api/transcription/models/status"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ models }),
		},
	);

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	return parseModelListResult({ payload: await response.json() });
}

export async function downloadTranscriptionModel({
	model,
}: {
	model: string;
}): Promise<BackendModelStatus> {
	const response = await fetch(
		resolveTranscriptionUrl("/api/transcription/models/download"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
		},
	);

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	return parseModelDownloadResult({ payload: await response.json() });
}

function resolveTranscriptionUrl(path: string) {
	return new URL(path, TRANSCRIPTION_API_BASE).toString();
}

async function readErrorMessage({ response }: { response: Response }) {
	try {
		const payload: unknown = await response.json();

		if (!isRecord(payload)) {
			return "The backend transcription request failed.";
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
			: "The backend transcription request failed.";
	} catch {
		return "The backend transcription request failed.";
	}
}

function parseTranscriptionResult({
	payload,
}: {
	payload: unknown;
}): TranscriptionResult {
	if (!isRecord(payload) || !Array.isArray(payload.segments)) {
		throw new Error("Backend returned an invalid transcription payload.");
	}

	if (
		typeof payload.text !== "string" ||
		typeof payload.language !== "string"
	) {
		throw new Error("Backend returned an invalid transcription payload.");
	}

	return {
		text: payload.text,
		language: payload.language,
		segments: payload.segments
			.map((segment) => parseTranscriptionSegment({ payload: segment }))
			.filter((segment): segment is TranscriptionSegment => segment !== null),
	};
}

function parseTranscriptionSegment({
	payload,
}: {
	payload: unknown;
}): TranscriptionSegment | null {
	if (
		!isRecord(payload) ||
		typeof payload.text !== "string" ||
		typeof payload.start !== "number" ||
		typeof payload.end !== "number"
	) {
		return null;
	}

	const words = Array.isArray(payload.words)
		? payload.words
				.map((word) => parseTranscriptionWord({ payload: word }))
				.filter((word): word is TranscriptionWord => word !== null)
		: [];

	return {
		text: payload.text,
		start: payload.start,
		end: payload.end,
		...(words.length > 0 ? { words } : {}),
	};
}

function parseTranscriptionWord({
	payload,
}: {
	payload: unknown;
}): TranscriptionWord | null {
	if (
		!isRecord(payload) ||
		typeof payload.word !== "string" ||
		typeof payload.start !== "number" ||
		typeof payload.end !== "number"
	) {
		return null;
	}

	return {
		word: payload.word,
		start: payload.start,
		end: payload.end,
		...(typeof payload.probability === "number"
			? { probability: payload.probability }
			: {}),
	};
}

function parseModelListResult({
	payload,
}: {
	payload: unknown;
}): BackendModelListResult {
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new Error("Backend returned an invalid model list payload.");
	}

	const models = payload.models
		.map((entry) => parseModelStatus({ payload: entry }))
		.filter((entry): entry is BackendModelStatus => entry !== null);

	return {
		default: typeof payload.default === "string" ? payload.default : null,
		active: typeof payload.active === "string" ? payload.active : null,
		models,
	};
}

function parseModelDownloadResult({
	payload,
}: {
	payload: unknown;
}): BackendModelStatus {
	if (!isRecord(payload) || typeof payload.model !== "string") {
		throw new Error("Backend returned an invalid model download payload.");
	}

	return { id: payload.model, downloaded: payload.downloaded === true };
}

function parseModelStatus({
	payload,
}: {
	payload: unknown;
}): BackendModelStatus | null {
	if (!isRecord(payload) || typeof payload.id !== "string") {
		return null;
	}

	return { id: payload.id, downloaded: payload.downloaded === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
