/**
 * Human-readable technical info for a media asset (MED-003) — resolution,
 * duration, frame rate, size — assembled from the metadata already carried on
 * the asset (no ffprobe round-trip). Pure formatting over plain fields, so it
 * unit-tests directly and can back any readout (clip menu, attributes panel).
 */

export interface MediaInfoInput {
	/** "image" | "video" | "audio". */
	type: string;
	/** File size in bytes. */
	size: number;
	width?: number;
	height?: number;
	/** Duration in seconds. */
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
}

export interface MediaInfoRow {
	label: string;
	value: string;
}

/** File size with a sensible unit (B/KB/MB/GB/TB). */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(
		units.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const value = bytes / 1024 ** exponent;
	// Whole bytes are exact; larger units keep 1–2 significant decimals.
	const decimals = exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(decimals)} ${units[exponent]}`;
}

/** Duration as `m:ss`, or `h:mm:ss` once past an hour. */
export function formatMediaDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return "0:00";
	}
	const total = Math.floor(seconds);
	const hrs = Math.floor(total / 3600);
	const mins = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const ss = secs.toString().padStart(2, "0");
	if (hrs > 0) {
		return `${hrs}:${mins.toString().padStart(2, "0")}:${ss}`;
	}
	return `${mins}:${ss}`;
}

/** Frame rate without trailing zeros: 30 → "30", 29.97 → "29.97". */
export function formatFps(fps: number): string {
	if (Number.isInteger(fps)) {
		return String(fps);
	}
	return fps.toFixed(2).replace(/\.?0+$/, "");
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/**
 * Build the labelled info rows for an asset. Only present fields appear, so an
 * image omits duration/frame-rate/audio and an audio file omits resolution.
 */
export function buildMediaInfoRows(asset: MediaInfoInput): MediaInfoRow[] {
	const rows: MediaInfoRow[] = [{ label: "Type", value: capitalize(asset.type) }];
	if (asset.width && asset.height) {
		rows.push({ label: "Resolution", value: `${asset.width}×${asset.height}` });
	}
	if (asset.duration && asset.duration > 0) {
		rows.push({
			label: "Duration",
			value: formatMediaDuration(asset.duration),
		});
	}
	if (asset.fps && asset.fps > 0) {
		rows.push({ label: "Frame rate", value: `${formatFps(asset.fps)} fps` });
	}
	if (asset.type === "video" || asset.type === "audio") {
		rows.push({ label: "Audio", value: asset.hasAudio ? "Yes" : "No" });
	}
	rows.push({ label: "Size", value: formatFileSize(asset.size) });
	return rows;
}
