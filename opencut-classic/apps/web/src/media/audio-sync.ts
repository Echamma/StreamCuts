/**
 * Audio synchronisation by waveform cross-correlation (MED-007).
 *
 * Given two loudness envelopes of the same event recorded separately (e.g. a
 * camera's scratch track and a dedicated recorder), the lag that maximises their
 * normalised cross-correlation is the time offset between them — the basis of
 * dual-system sync and multicam alignment.
 *
 * Pure math over `number[]`/`Float32Array` envelopes — no wasm, no I/O — so it
 * unit-tests directly. Envelope extraction (RMS buckets) already lives in
 * `media/waveform-summary`; this module only consumes the resulting arrays.
 */

export interface SyncOffset {
	/**
	 * Offset of `target` relative to `reference`, in envelope samples. Positive
	 * means `target` starts *later* (is delayed) — shift it earlier by this many
	 * samples to align. Negative means `target` is earlier.
	 */
	offsetSamples: number;
	/** Normalised correlation at the best lag, in [-1, 1]. Higher = more confident. */
	score: number;
}

/**
 * Pearson correlation between `reference[i]` and `target[i - lag]` over their
 * overlapping region. Returns `-Infinity` when the overlap is too small or
 * either side is constant (no correlation defined).
 */
function correlationAtLag({
	reference,
	target,
	lag,
	minOverlap,
}: {
	reference: ArrayLike<number>;
	target: ArrayLike<number>;
	lag: number;
	minOverlap: number;
}): number {
	const start = Math.max(0, lag);
	const end = Math.min(reference.length, target.length + lag);
	const count = end - start;
	// Too little overlap gives a spuriously perfect correlation (two points
	// always correlate ±1), so lags whose overlap is below `minOverlap` are
	// rejected outright.
	if (count < minOverlap) {
		return Number.NEGATIVE_INFINITY;
	}

	let sumR = 0;
	let sumT = 0;
	for (let i = start; i < end; i++) {
		sumR += reference[i];
		sumT += target[i - lag];
	}
	const meanR = sumR / count;
	const meanT = sumT / count;

	let numerator = 0;
	let varR = 0;
	let varT = 0;
	for (let i = start; i < end; i++) {
		const dr = reference[i] - meanR;
		const dt = target[i - lag] - meanT;
		numerator += dr * dt;
		varR += dr * dr;
		varT += dt * dt;
	}
	if (varR === 0 || varT === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	return numerator / Math.sqrt(varR * varT);
}

/**
 * Estimate the offset between two envelopes by scanning lags in
 * `[-maxLagSamples, maxLagSamples]` for the peak normalised correlation.
 * `maxLagSamples` defaults to the longer envelope's length (full scan).
 */
export function estimateSyncOffsetSamples({
	reference,
	target,
	maxLagSamples,
	minOverlapSamples,
}: {
	reference: ArrayLike<number>;
	target: ArrayLike<number>;
	maxLagSamples?: number;
	/** Reject lags whose overlap is below this many samples. Defaults to half
	 * the shorter envelope, so correlations are always over substantial data. */
	minOverlapSamples?: number;
}): SyncOffset {
	const span =
		maxLagSamples ?? Math.max(reference.length, target.length) - 1;
	const maxLag = Math.max(0, Math.floor(span));
	const minOverlap =
		minOverlapSamples ??
		Math.max(2, Math.floor(Math.min(reference.length, target.length) / 2));

	let bestLag = 0;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let lag = -maxLag; lag <= maxLag; lag++) {
		const score = correlationAtLag({ reference, target, lag, minOverlap });
		if (score > bestScore) {
			bestScore = score;
			bestLag = lag;
		}
	}

	// `correlationAtLag` peaks at lag = -delay when `target` is `reference`
	// delayed; negate so a positive result means "target is later". The
	// `=== 0 ? 0` guard normalises `-0` away.
	return {
		offsetSamples: bestLag === 0 ? 0 : -bestLag,
		score: bestScore === Number.NEGATIVE_INFINITY ? 0 : bestScore,
	};
}

/**
 * Convenience wrapper returning the offset in seconds, given the envelope
 * sample rate (buckets per second). `maxLagSeconds` bounds the search window.
 */
export function estimateSyncOffsetSeconds({
	reference,
	target,
	samplesPerSecond,
	maxLagSeconds,
}: {
	reference: ArrayLike<number>;
	target: ArrayLike<number>;
	samplesPerSecond: number;
	maxLagSeconds?: number;
}): { offsetSeconds: number; score: number } {
	if (samplesPerSecond <= 0) {
		throw new Error("samplesPerSecond must be positive");
	}
	const maxLagSamples =
		maxLagSeconds === undefined
			? undefined
			: Math.round(maxLagSeconds * samplesPerSecond);
	const { offsetSamples, score } = estimateSyncOffsetSamples({
		reference,
		target,
		maxLagSamples,
	});
	return { offsetSeconds: offsetSamples / samplesPerSecond, score };
}
