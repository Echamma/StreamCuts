import { resolveLongToShortUrl } from "@/long-to-short/api";

/**
 * Client for the backend transcode endpoints (DEL-003 ProRes, MED-005 proxies).
 * The engine and HTTP surface live in `backend/long-to-short`; this uploads a
 * media file and hands back the probe summary + a download URL. Shares the
 * backend base with the long-to-short client (same service).
 */

export type ProResProfile =
	| "proxy"
	| "lt"
	| "standard"
	| "hq"
	| "4444"
	| "4444xq";

export interface TranscodeProbeSummary {
	videoCodec: string | null;
	audioCodec: string | null;
	width: number | null;
	height: number | null;
	durationSeconds: number | null;
}

export interface TranscodeResult {
	id: string;
	fileName: string;
	video: TranscodeProbeSummary;
}

/** Transcode a file to a 540p (default) H.264 editing proxy (MED-005). */
export async function requestProxy({
	file,
	height,
}: {
	file: File;
	height?: number;
}): Promise<TranscodeResult> {
	const formData = new FormData();
	formData.set("video", file);
	if (height != null) {
		formData.set("height", String(height));
	}
	return postTranscode({ path: "/api/transcode/proxy", formData });
}

/** Transcode a file to an Apple ProRes master (DEL-003). */
export async function requestProRes({
	file,
	profile,
}: {
	file: File;
	profile?: ProResProfile;
}): Promise<TranscodeResult> {
	const formData = new FormData();
	formData.set("video", file);
	if (profile) {
		formData.set("profile", profile);
	}
	return postTranscode({ path: "/api/transcode/prores", formData });
}

/** Audio-only delivery formats (DEL-007). */
export type AudioExportFormat = "mp3" | "aac" | "wav" | "flac";

/** Export just the audio track of a file to a delivery format (DEL-007). The
 * result's `fileName` downloads via {@link transcodeOutputUrl}. */
export async function requestAudioExport({
	file,
	format,
	bitrate,
}: {
	file: File;
	format?: AudioExportFormat;
	bitrate?: string;
}): Promise<TranscodeResult> {
	const formData = new FormData();
	formData.set("video", file);
	if (format) {
		formData.set("format", format);
	}
	if (bitrate) {
		formData.set("bitrate", bitrate);
	}
	return postTranscode({ path: "/api/transcode/audio", formData });
}

/** Download URL for a transcode output (served with Content-Disposition). */
export function transcodeOutputUrl({ fileName }: { fileName: string }): string {
	return resolveLongToShortUrl({
		path: `/api/transcode/outputs/${encodeURIComponent(fileName)}`,
	});
}

async function postTranscode({
	path,
	formData,
}: {
	path: string;
	formData: FormData;
}): Promise<TranscodeResult> {
	const response = await fetch(resolveLongToShortUrl({ path }), {
		method: "POST",
		body: formData,
	});
	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}
	return parseTranscodeResult({ payload: await response.json() });
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
		// fall through to the status text
	}
	return `Transcode failed (${response.status}).`;
}

function parseTranscodeResult({ payload }: { payload: unknown }): TranscodeResult {
	if (typeof payload !== "object" || payload === null) {
		throw new Error("Malformed transcode response.");
	}
	const id = "id" in payload ? payload.id : null;
	const fileName = "fileName" in payload ? payload.fileName : null;
	if (typeof id !== "string" || typeof fileName !== "string") {
		throw new Error("Malformed transcode response.");
	}
	const video = "video" in payload ? payload.video : null;
	return { id, fileName, video: parseProbeSummary({ value: video }) };
}

const EMPTY_PROBE: TranscodeProbeSummary = {
	videoCodec: null,
	audioCodec: null,
	width: null,
	height: null,
	durationSeconds: null,
};

function parseProbeSummary({
	value,
}: {
	value: unknown;
}): TranscodeProbeSummary {
	if (typeof value !== "object" || value === null) {
		return EMPTY_PROBE;
	}
	return {
		videoCodec:
			"videoCodec" in value && typeof value.videoCodec === "string"
				? value.videoCodec
				: null,
		audioCodec:
			"audioCodec" in value && typeof value.audioCodec === "string"
				? value.audioCodec
				: null,
		width: "width" in value && typeof value.width === "number" ? value.width : null,
		height:
			"height" in value && typeof value.height === "number" ? value.height : null,
		durationSeconds:
			"durationSeconds" in value && typeof value.durationSeconds === "number"
				? value.durationSeconds
				: null,
	};
}
