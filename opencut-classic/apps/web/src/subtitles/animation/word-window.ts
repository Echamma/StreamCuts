/** Pure timing math for word-by-word caption animation. Kept free of canvas and
 * external imports so it can be unit-tested in isolation; the drawing code in
 * `@/text/caption-animation` consumes these to decide which word is active. */

export interface WordWindow {
	/** Element-local seconds the word becomes active. */
	start: number;
	/** Element-local seconds the word stops being active. */
	end: number;
}

/** Split a duration into `wordCount` back-to-back equal windows. Used when no
 * real per-word timings are available (manual/imported captions). */
export function resolveEvenSplitWindows({
	wordCount,
	durationSeconds,
}: {
	wordCount: number;
	durationSeconds: number;
}): WordWindow[] {
	if (wordCount <= 0) return [];
	const step = durationSeconds / wordCount;
	return Array.from({ length: wordCount }, (_, index) => ({
		start: index * step,
		end: (index + 1) * step,
	}));
}

/** Resolve per-word active windows, preferring real timings when their count
 * matches the laid-out word count, otherwise falling back to an even split. */
export function resolveWordWindows({
	wordCount,
	durationSeconds,
	words,
}: {
	wordCount: number;
	durationSeconds: number;
	words?: ReadonlyArray<{ start: number; end: number }>;
}): WordWindow[] {
	if (words && words.length === wordCount && wordCount > 0) {
		return words.map((word) => ({ start: word.start, end: word.end }));
	}
	return resolveEvenSplitWindows({ wordCount, durationSeconds });
}

export interface ActiveWordState {
	/** Index of the word whose window contains `currentTime`, or -1 in a gap. */
	containedIndex: number;
	/** Index of the last word that has started, or -1 before the first. */
	lastStartedIndex: number;
	/** The word treated as "current": the contained word, or (in a gap) the
	 * most recently started word so highlight/scale don't flicker off. */
	currentIndex: number;
}

export function computeActiveWord({
	windows,
	currentTime,
}: {
	windows: ReadonlyArray<WordWindow>;
	currentTime: number;
}): ActiveWordState {
	let containedIndex = -1;
	let lastStartedIndex = -1;
	for (let i = 0; i < windows.length; i++) {
		if (currentTime >= windows[i].start) lastStartedIndex = i;
		if (currentTime >= windows[i].start && currentTime < windows[i].end) {
			containedIndex = i;
		}
	}
	return {
		containedIndex,
		lastStartedIndex,
		currentIndex: containedIndex >= 0 ? containedIndex : lastStartedIndex,
	};
}
