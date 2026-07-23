/**
 * COL-009 scope math — pure functions that turn a sample of RGBA pixels into
 * waveform + histogram bin arrays. No canvas access, no DOM: consumers hand in
 * a `Uint8ClampedArray` (as returned by `ImageData.data`) plus the sampled
 * width/height. Tests exercise these directly.
 *
 * Both scopes take a downscaled tap (~480×270) so a single frame is ~0.5 MB
 * and reductions stay under a millisecond on modern hardware.
 */

/** Rec.709 luma weights — matches the color-grade shader. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export interface ScopeSample {
	/** Row-major RGBA bytes, length = width * height * 4. */
	pixels: Uint8ClampedArray;
	width: number;
	height: number;
}

export interface WaveformResult {
	/**
	 * `columns` × `luma_bins` (row-major, `col * lumaBins + bin` addressing).
	 * Each cell is the number of source-pixels that fell in that (x, luma) bin.
	 */
	counts: Uint32Array;
	columns: number;
	lumaBins: number;
	/** Peak cell count — consumers normalise brightness against this. */
	peak: number;
}

/**
 * Build a luma waveform: for each of `columns` x-buckets, count how many source
 * pixels land in each of `lumaBins` brightness bands (0=black, top=white).
 *
 * @param columns  Output column count; typically the display width divided
 *                 by 1–2 device pixels (e.g. 256). Must be >=1.
 * @param lumaBins Vertical resolution of the luma axis (e.g. 256). Must be >=1.
 */
export function computeWaveform({
	sample,
	columns,
	lumaBins,
}: {
	sample: ScopeSample;
	columns: number;
	lumaBins: number;
}): WaveformResult {
	if (columns < 1 || lumaBins < 1) {
		throw new Error("computeWaveform: columns and lumaBins must be >= 1");
	}

	const { pixels, width, height } = sample;
	const counts = new Uint32Array(columns * lumaBins);
	let peak = 0;

	if (width === 0 || height === 0) {
		return { counts, columns, lumaBins, peak };
	}

	const columnScale = columns / width;

	for (let y = 0; y < height; y++) {
		const rowStart = y * width * 4;
		for (let x = 0; x < width; x++) {
			const i = rowStart + x * 4;
			const r = pixels[i] ?? 0;
			const g = pixels[i + 1] ?? 0;
			const b = pixels[i + 2] ?? 0;
			const luma =
				(LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255; // 0..1

			const col = Math.min(columns - 1, Math.floor(x * columnScale));
			// Scale by lumaBins (not lumaBins-1) so bin edges are integer
			// intervals; FP jitter near 1.0 doesn't undershoot the top bin.
			const bin = Math.min(lumaBins - 1, Math.floor(luma * lumaBins));
			const idx = col * lumaBins + bin;
			const next = counts[idx]! + 1;
			counts[idx] = next;
			if (next > peak) peak = next;
		}
	}

	return { counts, columns, lumaBins, peak };
}

export interface HistogramResult {
	/** 256 bins per channel. */
	red: Uint32Array;
	green: Uint32Array;
	blue: Uint32Array;
	luma: Uint32Array;
	/** Peak across ALL channels — for shared y-axis normalisation. */
	peak: number;
}

/**
 * 256-bin histogram per RGB channel plus luma. All four share the same y
 * normalisation so the traces are directly comparable.
 */
export function computeHistogram({
	sample,
}: {
	sample: ScopeSample;
}): HistogramResult {
	const red = new Uint32Array(256);
	const green = new Uint32Array(256);
	const blue = new Uint32Array(256);
	const luma = new Uint32Array(256);

	const { pixels, width, height } = sample;
	if (width === 0 || height === 0) {
		return { red, green, blue, luma, peak: 0 };
	}

	let peak = 0;
	const total = width * height * 4;
	for (let i = 0; i < total; i += 4) {
		const r = pixels[i] ?? 0;
		const g = pixels[i + 1] ?? 0;
		const b = pixels[i + 2] ?? 0;
		const y = Math.min(
			255,
			Math.round(LUMA_R * r + LUMA_G * g + LUMA_B * b),
		);
		const rn = red[r]! + 1;
		const gn = green[g]! + 1;
		const bn = blue[b]! + 1;
		const yn = luma[y]! + 1;
		red[r] = rn;
		green[g] = gn;
		blue[b] = bn;
		luma[y] = yn;
		if (rn > peak) peak = rn;
		if (gn > peak) peak = gn;
		if (bn > peak) peak = bn;
		if (yn > peak) peak = yn;
	}

	return { red, green, blue, luma, peak };
}
