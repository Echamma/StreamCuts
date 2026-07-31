/**
 * Map scene-detection cuts (source-time seconds, from the backend MED-008
 * endpoint) to element-local clip-marker positions, in ticks, for one clip.
 *
 * A clip shows source content from `trimStartSeconds`, at its retime `rate`
 * (source advances `rate`× per unit of clip time), so a cut at source time `S`
 * lands at element-local time `L = (S - trimStartSeconds) / rate`. Cuts outside
 * the clip's visible span `(0, durationTicks)` are dropped; results are sorted
 * and de-duplicated.
 *
 * Deliberately pure arithmetic over plain numbers — no `@/wasm` import — so it
 * tests without a MediaTime mock (and can't leak one into sibling suites). The
 * caller passes `ticksPerSecond` and converts the returned ticks to `MediaTime`.
 */
export function sourceCutsToClipMarkerTicks({
	cuts,
	trimStartSeconds,
	durationTicks,
	ticksPerSecond,
	rate = 1,
}: {
	/** Cut positions in source-time seconds (from ffmpeg). */
	cuts: number[];
	/** Source offset (seconds) shown at the clip's start. */
	trimStartSeconds: number;
	/** The clip's visible length, in ticks. */
	durationTicks: number;
	/** Ticks per second (project time base). */
	ticksPerSecond: number;
	/** Retime rate (default 1). */
	rate?: number;
}): number[] {
	if (rate <= 0 || ticksPerSecond <= 0) {
		return [];
	}
	const seen = new Set<number>();
	const result: number[] = [];

	for (const cutSeconds of cuts) {
		const localSeconds = (cutSeconds - trimStartSeconds) / rate;
		if (localSeconds <= 0) {
			continue;
		}
		const localTicks = Math.round(localSeconds * ticksPerSecond);
		// Strictly inside the clip: a marker at the start (0) or at/past the end
		// adds nothing.
		if (localTicks <= 0 || localTicks >= durationTicks) {
			continue;
		}
		if (seen.has(localTicks)) {
			continue;
		}
		seen.add(localTicks);
		result.push(localTicks);
	}

	return result.sort((a, b) => a - b);
}
