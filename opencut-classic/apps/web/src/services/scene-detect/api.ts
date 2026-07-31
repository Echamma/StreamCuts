import { resolveLongToShortUrl } from "@/long-to-short/api";

/**
 * Client for the backend scene-detection endpoint (MED-008). Uploads a media
 * file and returns the detected cut timestamps (seconds). Shares the backend
 * base with the long-to-short / transcode clients (same service).
 */

export interface SceneDetectResult {
	cuts: number[];
}

/** Detect scene cuts in `file`. `threshold` (0–1) tunes sensitivity. */
export async function requestSceneDetect({
	file,
	threshold,
}: {
	file: File;
	threshold?: number;
}): Promise<SceneDetectResult> {
	const formData = new FormData();
	formData.set("video", file);
	if (threshold != null) {
		formData.set("threshold", String(threshold));
	}

	const response = await fetch(
		resolveLongToShortUrl({ path: "/api/scene-detect" }),
		{ method: "POST", body: formData },
	);
	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}
	return parseResult({ payload: await response.json() });
}

async function readErrorMessage({
	response,
}: {
	response: Response;
}): Promise<string> {
	try {
		const payload: unknown = await response.json();
		if (
			typeof payload === "object" &&
			payload !== null &&
			"message" in payload &&
			typeof payload.message === "string"
		) {
			return payload.message;
		}
	} catch {
		// fall through
	}
	return `Scene detection failed (${response.status}).`;
}

function parseResult({ payload }: { payload: unknown }): SceneDetectResult {
	const raw =
		typeof payload === "object" && payload !== null && "cuts" in payload
			? payload.cuts
			: null;
	if (!Array.isArray(raw)) {
		throw new Error("Malformed scene-detect response.");
	}
	const cuts: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		const value: unknown = raw[i];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error("Malformed scene-detect response.");
		}
		cuts.push(value);
	}
	return { cuts };
}
