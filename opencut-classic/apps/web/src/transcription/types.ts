import type { LanguageCode } from "./languages";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionWord {
	word: string;
	start: number;
	end: number;
	probability?: number;
}

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
	/**
	 * Per-word timings from the transcription backend. When present, captions are
	 * timed from real word boundaries instead of estimating from the segment.
	 */
	words?: TranscriptionWord[];
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
}

/** A word boundary inside a caption chunk, in absolute timeline seconds. */
export interface CaptionChunkWord {
	text: string;
	start: number;
	end: number;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
	/** Per-word timings (absolute seconds), when the transcription produced
	 * word-level boundaries. Used to drive accurate word-by-word caption
	 * animation; absent for estimated chunks and imported subtitle files. */
	words?: CaptionChunkWord[];
}
