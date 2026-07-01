import type { CaptionCueWithWords, CaptionWord } from "./types";

/** Half-open boundary: a word is active for `[word.start, word.end)`.
 * This matches MediaTime tick conventions used elsewhere in the renderer
 * (a clip at trimStart 0 duration N is active for `[0, N)`). The half-open
 * choice avoids two adjacent words both claiming the boundary timestamp,
 * which is the classic off-by-one in karaoke highlighting. */
export function findActiveWord({
	cue,
	timeSeconds,
}: {
	cue: CaptionCueWithWords;
	timeSeconds: number;
}): { word: CaptionWord; index: number } | null {
	if (timeSeconds < cue.startTime || timeSeconds >= cue.endTime) return null;
	for (let i = 0; i < cue.words.length; i++) {
		const word = cue.words[i];
		if (timeSeconds >= word.start && timeSeconds < word.end) {
			return { word, index: i };
		}
	}
	return null;
}

/** Index of the most-recently activated word at or before `timeSeconds`.
 * Used by typewriter where words remain visible after they activate. */
export function findLastWordIndexActivated({
	cue,
	timeSeconds,
}: {
	cue: CaptionCueWithWords;
	timeSeconds: number;
}): number {
	if (timeSeconds < cue.startTime) return -1;
	if (cue.words.length === 0) return -1;
	let last = -1;
	for (let i = 0; i < cue.words.length; i++) {
		if (cue.words[i].start <= timeSeconds) {
			last = i;
		} else {
			break;
		}
	}
	return last;
}
