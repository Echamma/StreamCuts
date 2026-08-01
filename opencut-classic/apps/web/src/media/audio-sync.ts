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

/**
 * Resample an amplitude envelope from `fromRate` to `toRate` buckets/second by
 * linear interpolation (edges clamped). Used to put two source envelopes on a
 * common timebase before correlating, so a sample of lag means the same amount
 * of time on both sides.
 */
export function resampleEnvelope({
	envelope,
	fromRate,
	toRate,
}: {
	envelope: ArrayLike<number>;
	fromRate: number;
	toRate: number;
}): number[] {
	if (fromRate <= 0 || toRate <= 0) {
		throw new Error("resampleEnvelope rates must be positive");
	}
	const inLength = envelope.length;
	if (inLength === 0) {
		return [];
	}
	if (fromRate === toRate) {
		return Array.from({ length: inLength }, (_, i) => envelope[i]);
	}
	// Source samples advanced per output sample.
	const ratio = fromRate / toRate;
	const outLength = Math.max(1, Math.round(inLength / ratio));
	const result = new Array<number>(outLength);
	for (let j = 0; j < outLength; j++) {
		const srcPos = j * ratio;
		const i0 = Math.floor(srcPos);
		const frac = srcPos - i0;
		const a = envelope[Math.min(i0, inLength - 1)];
		const b = envelope[Math.min(i0 + 1, inLength - 1)];
		result[j] = a + (b - a) * frac;
	}
	return result;
}

/**
 * A whole-source amplitude envelope with the metadata needed to place it in
 * time. Structurally matches `media/waveform-summary`'s `SourceWaveformSummary`
 * (`amplitudes` peak buckets, `sampleRate` Hz, `bucketSize` source samples per
 * bucket), so a summary built for the waveform display feeds straight in.
 */
export interface EnvelopeSummary {
	amplitudes: ArrayLike<number>;
	sampleRate: number;
	bucketSize: number;
}

/** Envelope buckets per second = audio sample rate ÷ source samples per bucket. */
function envelopeRate(summary: EnvelopeSummary): number {
	return summary.sampleRate / summary.bucketSize;
}

/**
 * Estimate the sync offset between two source media given their waveform
 * summaries, correcting for differing bucket rates. The finer envelope is
 * resampled down to the coarser one's rate, then cross-correlated; the result
 * is reported in seconds (positive = the shared event is *later* in the target
 * source than in the reference). Degenerate inputs (empty/one-bucket envelopes,
 * non-positive rates) yield a zero offset with zero confidence.
 */
export function estimateSyncOffsetFromSummaries({
	reference,
	target,
	maxLagSeconds,
}: {
	reference: EnvelopeSummary;
	target: EnvelopeSummary;
	maxLagSeconds?: number;
}): { offsetSeconds: number; score: number } {
	const refRate = envelopeRate(reference);
	const targetRate = envelopeRate(target);
	if (
		!Number.isFinite(refRate) ||
		refRate <= 0 ||
		!Number.isFinite(targetRate) ||
		targetRate <= 0 ||
		reference.amplitudes.length < 2 ||
		target.amplitudes.length < 2
	) {
		return { offsetSeconds: 0, score: 0 };
	}

	const commonRate = Math.min(refRate, targetRate);
	const referenceEnvelope = resampleEnvelope({
		envelope: reference.amplitudes,
		fromRate: refRate,
		toRate: commonRate,
	});
	const targetEnvelope = resampleEnvelope({
		envelope: target.amplitudes,
		fromRate: targetRate,
		toRate: commonRate,
	});
	const maxLagSamples =
		maxLagSeconds === undefined
			? undefined
			: Math.round(maxLagSeconds * commonRate);
	const { offsetSamples, score } = estimateSyncOffsetSamples({
		reference: referenceEnvelope,
		target: targetEnvelope,
		maxLagSamples,
	});
	return { offsetSeconds: offsetSamples / commonRate, score };
}

/**
 * The timeline start (seconds) that aligns `target` to `reference` given the
 * measured content offset from {@link estimateSyncOffsetFromSummaries}.
 *
 * Each clip shows source content from its `trimStart`, at its native rate, so a
 * source event at reference-source-time `Sr` sits at timeline
 * `referenceTimelineStart + (Sr − referenceTrimStart)`; the same event is at
 * target-source-time `Sr + offsetSeconds`. Solving for the target start makes
 * `Sr` cancel — alignment is content-independent — and gives the expression
 * below. Both clips are assumed un-retimed (rate 1), the dual-system-audio case.
 *
 * The result may be negative (the aligned target would begin before the
 * timeline origin); the caller shifts both clips right, or clamps, as it sees
 * fit. Pure arithmetic over plain seconds — the caller converts `MediaTime`.
 */
export function planClipSyncStart({
	referenceTimelineStartSeconds,
	referenceTrimStartSeconds,
	targetTrimStartSeconds,
	offsetSeconds,
}: {
	referenceTimelineStartSeconds: number;
	referenceTrimStartSeconds: number;
	targetTrimStartSeconds: number;
	offsetSeconds: number;
}): { targetTimelineStartSeconds: number } {
	return {
		targetTimelineStartSeconds:
			referenceTimelineStartSeconds -
			referenceTrimStartSeconds +
			targetTrimStartSeconds -
			offsetSeconds,
	};
}
