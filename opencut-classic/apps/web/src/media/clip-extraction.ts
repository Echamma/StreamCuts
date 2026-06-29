import {
	Input,
	Output,
	Conversion,
	BlobSource,
	BufferTarget,
	Mp4OutputFormat,
	ALL_FORMATS,
} from "mediabunny";

export class ClipExtractionRequiresRenderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClipExtractionRequiresRenderError";
	}
}

const sanitizeFileStem = (value: string) =>
	value
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[<>:"/\\|?*]+/g, "-")
		.split("")
		.map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
		.join("")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase() || "clip";

const formatFileTimestamp = (seconds: number) => {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const remainingSeconds = total % 60;

	return [hours, minutes, remainingSeconds]
		.map((value) => String(value).padStart(2, "0"))
		.join("-");
};

/**
 * Trim a clip out of a source media file.
 *
 * Uses mediabunny's streaming Conversion: the input is read through a
 * `BlobSource` (ranged reads, bounded memory) and only the trimmed window is
 * decoded/encoded via WebCodecs. This is the same low-memory read path that
 * powers playback, so it works for very large (multi-GB) sources — unlike the
 * previous ffmpeg.wasm approach, which loaded the entire file into the wasm
 * heap and failed with NotReadableError / out-of-memory on large files.
 */
export const extractMediaClip = async ({
	file,
	kind,
	startSeconds,
	durationSeconds,
	baseName,
	retimeRate,
	includeAudio,
}: {
	file: File;
	kind: "video" | "audio";
	startSeconds: number;
	durationSeconds: number;
	baseName: string;
	retimeRate?: number;
	includeAudio?: boolean;
}): Promise<File> => {
	const safeStartSeconds = Math.max(0, startSeconds);
	const safeDurationSeconds = Math.max(0.1, durationSeconds);

	if (
		kind === "video" &&
		retimeRate != null &&
		Math.abs(retimeRate - 1) > 1e-6
	) {
		throw new ClipExtractionRequiresRenderError(
			"Retimed video clips must be rendered before they can be saved.",
		);
	}

	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});
	const target = new BufferTarget();
	const output = new Output({
		format: new Mp4OutputFormat(),
		target,
	});

	try {
		const conversion = await Conversion.init({
			input,
			output,
			trim: {
				start: safeStartSeconds,
				end: safeStartSeconds + safeDurationSeconds,
			},
			// Keep only the tracks the caller wants in the output.
			video: kind === "audio" ? { discard: true } : undefined,
			audio:
				kind === "video" && includeAudio !== true
					? { discard: true }
					: undefined,
		});

		if (
			kind === "video" &&
			includeAudio === true &&
			conversion.discardedTracks.some(({ track }) => track.isAudioTrack())
		) {
			throw new ClipExtractionRequiresRenderError(
				"The source audio track cannot be copied directly and must be rendered.",
			);
		}

		await conversion.execute();
	} finally {
		input.dispose();
	}

	const buffer = target.buffer;
	if (!buffer || buffer.byteLength === 0) {
		throw new Error("Clip export produced no data.");
	}

	const outputExt = kind === "video" ? "mp4" : "m4a";
	const outputMimeType = kind === "video" ? "video/mp4" : "audio/mp4";
	const clipName = `${sanitizeFileStem(baseName)}-${formatFileTimestamp(
		safeStartSeconds,
	)}-${formatFileTimestamp(safeStartSeconds + safeDurationSeconds)}.${outputExt}`;

	return new File([buffer], clipName, {
		type: outputMimeType,
		lastModified: Date.now(),
	});
};
