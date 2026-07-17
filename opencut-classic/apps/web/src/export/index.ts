import type { FrameRate } from "opencut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm", "webm-av1"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];

/** File extension per format; `webm-av1` uses `.webm` (AV1 in a WebM container). */
export function getFormatFileExtension({
	format,
}: {
	format: ExportFormat;
}): ".mp4" | ".webm" {
	if (format === "mp4") return ".mp4";
	return ".webm";
}
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export type ExportSceneTarget =
	| { mode: "current" }
	| { mode: "specific"; sceneId: string }
	| { mode: "all" };

export type ExportOutputTarget =
	| { mode: "buffer" }
	| { mode: "file-system"; writable: FileSystemWritableFileStream };

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
	canvasSizeOverride?: { width: number; height: number };
	sceneTarget?: ExportSceneTarget;
	outputTarget?: ExportOutputTarget;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	wroteToFile?: boolean;
	error?: string;
	cancelled?: boolean;
}

export type ExportPhase = "idle" | "audio" | "video" | "finalizing";

export interface ExportState {
	isExporting: boolean;
	progress: number;
	phase: ExportPhase;
	statusText: string;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return getFormatFileExtension({ format });
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
