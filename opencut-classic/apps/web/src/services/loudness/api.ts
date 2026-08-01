import { resolveLongToShortUrl } from "@/long-to-short/api";

/**
 * Client for the backend EBU R128 loudness endpoint (FAIR-008). Uploads a media
 * file and returns its integrated loudness, range and true peak — the numbers a
 * delivery target is set against (YouTube ≈ −14 LUFS, EBU R128 = −23). Shares
 * the backend base with the long-to-short / transcode clients (same service).
 */

export interface LoudnessSummary {
	integratedLufs: number | null;
	loudnessRangeLu: number | null;
	truePeakDbfs: number | null;
	thresholdLufs: number | null;
}

/** Measure the loudness of `file` (audio or video). */
export async function requestLoudness({
	file,
}: {
	file: File;
}): Promise<LoudnessSummary> {
	const formData = new FormData();
	formData.set("media", file);

	const response = await fetch(resolveLongToShortUrl({ path: "/api/loudness" }), {
		method: "POST",
		body: formData,
	});
	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}
	return parseResult({ payload: await response.json() });
}

/** A loudness target for normalisation (unset fields use the backend defaults:
 * −14 LUFS / −1 dBFS TP / 11 LU). */
export interface LoudnessTarget {
	targetLufs?: number;
	targetTruePeak?: number;
	targetLra?: number;
}

export interface NormalizeResult {
	id: string;
	fileName: string;
}

/** Normalise `file` to a loudness target; the normalised WAV is then available
 * at {@link loudnessOutputUrl}. */
export async function requestLoudnessNormalize({
	file,
	target,
}: {
	file: File;
	target?: LoudnessTarget;
}): Promise<NormalizeResult> {
	const formData = new FormData();
	formData.set("media", file);
	if (target?.targetLufs != null) {
		formData.set("targetLufs", String(target.targetLufs));
	}
	if (target?.targetTruePeak != null) {
		formData.set("targetTruePeak", String(target.targetTruePeak));
	}
	if (target?.targetLra != null) {
		formData.set("targetLra", String(target.targetLra));
	}

	const response = await fetch(
		resolveLongToShortUrl({ path: "/api/loudness/normalize" }),
		{ method: "POST", body: formData },
	);
	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}
	const payload: unknown = await response.json();
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("fileName" in payload) ||
		typeof payload.fileName !== "string" ||
		!("id" in payload) ||
		typeof payload.id !== "string"
	) {
		throw new Error("Malformed loudness-normalize response.");
	}
	return { id: payload.id, fileName: payload.fileName };
}

/** Download URL for a normalised output produced by {@link requestLoudnessNormalize}. */
export function loudnessOutputUrl({ fileName }: { fileName: string }): string {
	return resolveLongToShortUrl({ path: `/api/loudness/outputs/${fileName}` });
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
	return `Loudness measurement failed (${response.status}).`;
}

/** A summary field is a finite number, or null when ffmpeg omitted it. */
function toFiniteOrNull(value: unknown): number | null {
	if (value === null) {
		return null;
	}
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseResult({ payload }: { payload: unknown }): LoudnessSummary {
	if (typeof payload !== "object" || payload === null) {
		throw new Error("Malformed loudness response.");
	}
	// `in` narrows each field to `unknown` without an unsafe cast.
	return {
		integratedLufs: toFiniteOrNull(
			"integratedLufs" in payload ? payload.integratedLufs : null,
		),
		loudnessRangeLu: toFiniteOrNull(
			"loudnessRangeLu" in payload ? payload.loudnessRangeLu : null,
		),
		truePeakDbfs: toFiniteOrNull(
			"truePeakDbfs" in payload ? payload.truePeakDbfs : null,
		),
		thresholdLufs: toFiniteOrNull(
			"thresholdLufs" in payload ? payload.thresholdLufs : null,
		),
	};
}
