import type { TranscriptionSegment, CaptionChunk } from "@/transcription/types";
import {
	CAPTION_PAUSE_GAP_SECONDS,
	DEFAULT_WORDS_PER_CAPTION,
	MAX_CAPTION_CHARACTERS,
	MAX_CAPTION_DURATION_SECONDS,
	MIN_CAPTION_DURATION_SECONDS,
} from "@/transcription/caption-defaults";

interface NormalizedWord {
	text: string;
	start: number;
	end: number;
}

const SENTENCE_END = /[.!?…]["'"')\]]?$/;

export function buildCaptionChunks({
	segments,
	wordsPerChunk = DEFAULT_WORDS_PER_CAPTION,
	minDuration = MIN_CAPTION_DURATION_SECONDS,
	maxDuration = MAX_CAPTION_DURATION_SECONDS,
	maxCharacters = MAX_CAPTION_CHARACTERS,
	pauseGap = CAPTION_PAUSE_GAP_SECONDS,
}: {
	segments: TranscriptionSegment[];
	wordsPerChunk?: number;
	minDuration?: number;
	maxDuration?: number;
	maxCharacters?: number;
	pauseGap?: number;
}): CaptionChunk[] {
	const safeWordsPerChunk =
		wordsPerChunk > 0 ? Math.floor(wordsPerChunk) : DEFAULT_WORDS_PER_CAPTION;

	const captions: CaptionChunk[] = [];

	for (const segment of segments) {
		const words = normalizeWords(segment);

		if (words.length > 0) {
			appendWordChunks({
				captions,
				words,
				wordsPerChunk: safeWordsPerChunk,
				minDuration,
				maxDuration,
				maxCharacters,
				pauseGap,
			});
		} else {
			appendEstimatedChunks({
				captions,
				segment,
				wordsPerChunk: safeWordsPerChunk,
				minDuration,
			});
		}
	}

	clampOverlaps(captions);

	return captions;
}

function normalizeWords(segment: TranscriptionSegment): NormalizedWord[] {
	if (!segment.words || segment.words.length === 0) return [];

	const words: NormalizedWord[] = [];
	for (const word of segment.words) {
		const text = word.word.trim();
		if (!text) continue;
		if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;

		words.push({
			text,
			start: word.start,
			end: Math.max(word.end, word.start),
		});
	}

	return words;
}

function appendWordChunks({
	captions,
	words,
	wordsPerChunk,
	minDuration,
	maxDuration,
	maxCharacters,
	pauseGap,
}: {
	captions: CaptionChunk[];
	words: NormalizedWord[];
	wordsPerChunk: number;
	minDuration: number;
	maxDuration: number;
	maxCharacters: number;
	pauseGap: number;
}): void {
	let current: NormalizedWord[] = [];

	const flush = () => {
		if (current.length === 0) return;

		const text = current
			.map((word) => word.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

		if (text) {
			const startTime = current[0].start;
			const end = current[current.length - 1].end;
			captions.push({
				text,
				startTime,
				duration: Math.max(end - startTime, minDuration),
			});
		}

		current = [];
	};

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		current.push(word);

		const chunkStart = current[0].start;
		const text = current.map((entry) => entry.text).join(" ");
		const nextWord = words[i + 1];
		const gapAfter = nextWord
			? nextWord.start - word.end
			: Number.POSITIVE_INFINITY;

		const reachedWordLimit = current.length >= wordsPerChunk;
		const reachedCharLimit = text.length >= maxCharacters;
		const reachedDurationLimit = word.end - chunkStart >= maxDuration;
		const endsSentence = SENTENCE_END.test(word.text);
		const longPause = gapAfter >= pauseGap;

		if (
			reachedWordLimit ||
			reachedCharLimit ||
			reachedDurationLimit ||
			endsSentence ||
			longPause
		) {
			flush();
		}
	}

	flush();
}

function appendEstimatedChunks({
	captions,
	segment,
	wordsPerChunk,
	minDuration,
}: {
	captions: CaptionChunk[];
	segment: TranscriptionSegment;
	wordsPerChunk: number;
	minDuration: number;
}): void {
	const words = segment.text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return;

	const segmentDuration = segment.end - segment.start;
	if (segmentDuration <= 0) return;

	const wordsPerSecond = words.length / segmentDuration;

	const chunks: string[] = [];
	for (let i = 0; i < words.length; i += wordsPerChunk) {
		chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
	}

	let chunkStartTime = segment.start;
	for (const chunk of chunks) {
		const adjustedStartTime = Math.max(chunkStartTime, lastCaptionEnd(captions));

		if (adjustedStartTime >= segment.end) break;

		const chunkWords = chunk.split(/\s+/).length;
		const naturalDuration = Math.max(minDuration, chunkWords / wordsPerSecond);

		const chunkEnd = Math.min(adjustedStartTime + naturalDuration, segment.end);
		const chunkDuration = chunkEnd - adjustedStartTime;

		if (chunkDuration < 0.1) break;

		captions.push({
			text: chunk,
			startTime: adjustedStartTime,
			duration: chunkDuration,
		});

		chunkStartTime += naturalDuration;
	}
}

function lastCaptionEnd(captions: CaptionChunk[]): number {
	const last = captions[captions.length - 1];
	return last ? last.startTime + last.duration : 0;
}

function clampOverlaps(captions: CaptionChunk[]): void {
	for (let i = 0; i < captions.length - 1; i++) {
		const current = captions[i];
		const next = captions[i + 1];
		const currentEnd = current.startTime + current.duration;

		if (currentEnd > next.startTime) {
			current.duration = Math.max(0.1, next.startTime - current.startTime);
		}
	}
}
