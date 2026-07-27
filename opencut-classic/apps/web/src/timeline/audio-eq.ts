import type { AudioCapableElement } from "@/timeline/audio-state";

/**
 * Parametric EQ DSP core (FAIR-004).
 *
 * This module is the pure, verifiable foundation of the equaliser: the biquad
 * coefficient math and a sample processor, plus a fixed 3-band data model read
 * from an element's flat `params`. It has **no** side effects and no `@/wasm`
 * dependency, so it unit-tests natively.
 *
 * The coefficient formulas follow the W3C Web Audio `BiquadFilterNode`
 * definitions (peaking uses `Q`; the shelves use a fixed slope `S = 1`, ignoring
 * `Q`, exactly as the spec does). Matching the spec is deliberate: when this is
 * wired, playback will run through native `BiquadFilterNode`s while offline
 * export runs through {@link processEqChain}, and the two must agree. Sharing
 * the spec's math makes them agree by construction.
 *
 * Safe by construction: the band model defaults every gain to 0 dB, and
 * {@link isEqFlat} reports a flat EQ as a no-op, so an element with no EQ params
 * (every existing project) is bypassed entirely.
 */

export type EqBandType = "lowshelf" | "peaking" | "highshelf";

export interface EqBand {
	type: EqBandType;
	/** Centre (peaking) or corner (shelf) frequency, Hz. */
	frequency: number;
	gainDb: number;
	/** Resonance for peaking bands; ignored by the shelves (spec slope S = 1). */
	q: number;
}

/** Unnormalised biquad transfer-function coefficients (`a0` not folded in). */
export interface BiquadCoefficients {
	b0: number;
	b1: number;
	b2: number;
	a0: number;
	a1: number;
	a2: number;
}

/** Fixed 3-band model corner/centre frequencies (Hz). */
export const EQ_LOW_FREQUENCY = 120;
export const EQ_HIGH_FREQUENCY = 12000;
export const EQ_DEFAULT_MID_FREQUENCY = 1000;
export const EQ_DEFAULT_Q = 1;
/** Below this |gain| (dB) a band is treated as flat (no audible effect). */
export const EQ_FLAT_EPSILON_DB = 1e-4;

/**
 * Biquad coefficients for one band, per the W3C Web Audio formulas.
 * `sampleRate` and `frequency` are in Hz; `gainDb` in decibels.
 */
export function biquadCoefficients({
	type,
	sampleRate,
	frequency,
	gainDb,
	q,
}: {
	type: EqBandType;
	sampleRate: number;
	frequency: number;
	gainDb: number;
	q: number;
}): BiquadCoefficients {
	const a = Math.pow(10, gainDb / 40);
	const w0 = (2 * Math.PI * frequency) / sampleRate;
	const cosW0 = Math.cos(w0);
	const sinW0 = Math.sin(w0);

	if (type === "peaking") {
		const alpha = sinW0 / (2 * q);
		return {
			b0: 1 + alpha * a,
			b1: -2 * cosW0,
			b2: 1 - alpha * a,
			a0: 1 + alpha / a,
			a1: -2 * cosW0,
			a2: 1 - alpha / a,
		};
	}

	// Shelves use the spec's slope-based alpha with S = 1, which reduces to
	// alpha = sin(w0)/2 * sqrt(2). `Q` does not participate.
	const alpha = (sinW0 / 2) * Math.SQRT2;
	const twoSqrtAAlpha = 2 * Math.sqrt(a) * alpha;
	const aMinus1CosW0 = (a - 1) * cosW0;
	const aPlus1CosW0 = (a + 1) * cosW0;

	if (type === "lowshelf") {
		return {
			b0: a * (a + 1 - aMinus1CosW0 + twoSqrtAAlpha),
			b1: 2 * a * (a - 1 - aPlus1CosW0),
			b2: a * (a + 1 - aMinus1CosW0 - twoSqrtAAlpha),
			a0: a + 1 + aMinus1CosW0 + twoSqrtAAlpha,
			a1: -2 * (a - 1 + aPlus1CosW0),
			a2: a + 1 + aMinus1CosW0 - twoSqrtAAlpha,
		};
	}

	// highshelf
	return {
		b0: a * (a + 1 + aMinus1CosW0 + twoSqrtAAlpha),
		b1: -2 * a * (a - 1 + aPlus1CosW0),
		b2: a * (a + 1 + aMinus1CosW0 - twoSqrtAAlpha),
		a0: a + 1 - aMinus1CosW0 + twoSqrtAAlpha,
		a1: 2 * (a - 1 - aPlus1CosW0),
		a2: a + 1 - aMinus1CosW0 - twoSqrtAAlpha,
	};
}

/**
 * Filter `samples` through one biquad (Direct Form I), returning a new array.
 * State starts at rest, so filtering a whole source buffer in one call is exact;
 * chunked callers must carry state across calls themselves.
 */
export function processBiquad({
	coefficients,
	samples,
}: {
	coefficients: BiquadCoefficients;
	samples: Float32Array;
}): Float32Array {
	const { a0 } = coefficients;
	const b0 = coefficients.b0 / a0;
	const b1 = coefficients.b1 / a0;
	const b2 = coefficients.b2 / a0;
	const a1 = coefficients.a1 / a0;
	const a2 = coefficients.a2 / a0;

	const output = new Float32Array(samples.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	for (let index = 0; index < samples.length; index++) {
		const x0 = samples[index];
		const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
		output[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}
	return output;
}

/**
 * Filter `samples` through a series of bands (skipping flat ones). Returns the
 * input unchanged when every band is flat, so a bypassed EQ is a true no-op.
 */
export function processEqChain({
	bands,
	sampleRate,
	samples,
}: {
	bands: EqBand[];
	sampleRate: number;
	samples: Float32Array;
}): Float32Array {
	let current = samples;
	for (const band of bands) {
		if (Math.abs(band.gainDb) < EQ_FLAT_EPSILON_DB) {
			continue;
		}
		current = processBiquad({
			coefficients: biquadCoefficients({
				type: band.type,
				sampleRate,
				frequency: band.frequency,
				gainDb: band.gainDb,
				q: band.q,
			}),
			samples: current,
		});
	}
	return current;
}

/**
 * Magnitude response of a biquad at `frequency`, in dB. Pure analysis helper —
 * used by tests to assert a band does what it should, independent of Web Audio.
 */
export function biquadFrequencyResponseDb({
	coefficients,
	frequency,
	sampleRate,
}: {
	coefficients: BiquadCoefficients;
	frequency: number;
	sampleRate: number;
}): number {
	const w = (2 * Math.PI * frequency) / sampleRate;
	const cosW = Math.cos(w);
	const sinW = Math.sin(w);
	const cos2W = Math.cos(2 * w);
	const sin2W = Math.sin(2 * w);

	// H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (a0 + a1 e^-jw + a2 e^-2jw)
	const numRe = coefficients.b0 + coefficients.b1 * cosW + coefficients.b2 * cos2W;
	const numIm = -(coefficients.b1 * sinW + coefficients.b2 * sin2W);
	const denRe = coefficients.a0 + coefficients.a1 * cosW + coefficients.a2 * cos2W;
	const denIm = -(coefficients.a1 * sinW + coefficients.a2 * sin2W);

	const numMagSq = numRe * numRe + numIm * numIm;
	const denMagSq = denRe * denRe + denIm * denIm;
	return 10 * Math.log10(numMagSq / denMagSq);
}

/**
 * The element's fixed 3-band EQ, read from flat `params`. Absent params (every
 * existing element) yield 0 dB gains — a flat, bypassed EQ. Additive: no
 * migration.
 */
export function resolveElementEqBands({
	element,
}: {
	element: AudioCapableElement;
}): EqBand[] {
	const { params } = element;
	const lowGainDb = readNumber({ value: params.eqLowGainDb, fallback: 0 });
	const midGainDb = readNumber({ value: params.eqMidGainDb, fallback: 0 });
	const midFrequency = readNumber({
		value: params.eqMidFrequency,
		fallback: EQ_DEFAULT_MID_FREQUENCY,
	});
	const midQ = readNumber({ value: params.eqMidQ, fallback: EQ_DEFAULT_Q });
	const highGainDb = readNumber({ value: params.eqHighGainDb, fallback: 0 });

	return [
		{
			type: "lowshelf",
			frequency: EQ_LOW_FREQUENCY,
			gainDb: lowGainDb,
			q: EQ_DEFAULT_Q,
		},
		{
			type: "peaking",
			frequency: midFrequency,
			gainDb: midGainDb,
			q: midQ,
		},
		{
			type: "highshelf",
			frequency: EQ_HIGH_FREQUENCY,
			gainDb: highGainDb,
			q: EQ_DEFAULT_Q,
		},
	];
}

/** Whether every band is within {@link EQ_FLAT_EPSILON_DB} of 0 dB (bypass). */
export function isEqFlat({ bands }: { bands: EqBand[] }): boolean {
	return bands.every((band) => Math.abs(band.gainDb) < EQ_FLAT_EPSILON_DB);
}

function readNumber({
	value,
	fallback,
}: {
	value: unknown;
	fallback: number;
}): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
