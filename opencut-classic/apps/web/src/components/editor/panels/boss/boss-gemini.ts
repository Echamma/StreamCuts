import { LONG_TO_SHORT_API_BASE } from "@/long-to-short/api";

export interface GeminiCueResponse {
	rawText: string;
	cues: number[];
}

export interface GeminiSegmentMetadata {
	title: string;
	description: string;
	warning: string | null;
}

export interface GeminiShortPlan {
	startSec: number;
	endSec: number;
	viralScore: number;
	reason: string;
	title: string;
	description: string;
	warning: string | null;
}

function bossUrl(path: string): string {
	return new URL(path, LONG_TO_SHORT_API_BASE).toString();
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const payload = (await response.json()) as Record<string, unknown>;
		if (typeof payload.message === "string") return payload.message;
		if (Array.isArray(payload.message))
			return (payload.message as string[]).join(" ");
	} catch {
		// ignore
	}
	return `Request failed with status ${response.status}.`;
}

export const requestCueSuggestions = async ({
	durationSeconds,
	userPrompt,
}: {
	durationSeconds: number;
	userPrompt: string;
}): Promise<GeminiCueResponse> => {
	const response = await fetch(bossUrl("/api/boss/cue-suggestions"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ durationSeconds, userPrompt }),
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	return response.json() as Promise<GeminiCueResponse>;
};

export const generateSegmentMetadata = async ({
	media,
	index,
	total,
	durationSeconds,
}: {
	media: Blob;
	index: number;
	total: number;
	durationSeconds: number;
}): Promise<GeminiSegmentMetadata> => {
	const form = new FormData();
	form.set("media", media);
	form.set("index", String(index));
	form.set("total", String(total));
	form.set("durationSeconds", String(durationSeconds));

	const response = await fetch(bossUrl("/api/boss/segment-metadata"), {
		method: "POST",
		body: form,
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	return response.json() as Promise<GeminiSegmentMetadata>;
};

export const generateShortPlan = async ({
	media,
	durationSeconds,
}: {
	media: Blob;
	durationSeconds: number;
}): Promise<GeminiShortPlan> => {
	const form = new FormData();
	form.set("media", media);
	form.set("durationSeconds", String(durationSeconds));

	const response = await fetch(bossUrl("/api/boss/short-plan"), {
		method: "POST",
		body: form,
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	return response.json() as Promise<GeminiShortPlan>;
};

export const generateSubtitlesSrt = async ({
	media,
}: {
	media: Blob;
}): Promise<string> => {
	const form = new FormData();
	form.set("media", media);

	const response = await fetch(bossUrl("/api/boss/subtitles"), {
		method: "POST",
		body: form,
	});

	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	const data = (await response.json()) as { srt: string };
	return data.srt;
};
