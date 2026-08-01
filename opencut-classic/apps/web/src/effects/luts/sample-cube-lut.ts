/**
 * CPU sampler for a parsed `.cube` colour LUT (COL-008) — the verifiable
 * reference implementation of what the GPU shader does per pixel. 1D LUTs apply
 * each channel's own curve; 3D LUTs trilinearly interpolate the eight grid
 * nodes surrounding the colour. Inputs are normalised through the LUT's input
 * domain and clamped to it, so out-of-range colours map to the nearest edge.
 *
 * Pure math over the {@link CubeLut} table — no GPU, no I/O — so it unit-tests
 * directly and can serve CPU paths (thumbnails, shader parity checks).
 */

import type { CubeLut } from "./cube-lut";

export type Rgb = [number, number, number];

function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/** Normalise one channel from the LUT's input domain into a clamped [0, 1]. */
function normaliseChannel({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	const span = max - min;
	// A degenerate (zero-width) domain has no gradient to sample; collapse to 0.
	if (span <= 0) {
		return 0;
	}
	return clamp01((value - min) / span);
}

function lerp3({ a, b, t }: { a: Rgb; b: Rgb; t: number }): Rgb {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t,
	];
}

/** One grid node of a 3D LUT — red-fastest flat layout `(r + g·size + b·size²)`. */
function node3d({
	table,
	size,
	r,
	g,
	b,
}: {
	table: Float32Array;
	size: number;
	r: number;
	g: number;
	b: number;
}): Rgb {
	const base = ((b * size + g) * size + r) * 3;
	return [table[base], table[base + 1], table[base + 2]];
}

interface Axis {
	/** Lower node index (clamped into range). */
	i0: number;
	/** Upper node index (clamped into range). */
	i1: number;
	/** Interpolation weight toward `i1`, in [0, 1]. */
	frac: number;
}

/** Where a normalised [0, 1] coordinate falls on a `size`-node axis. */
function axisPosition({ t, size }: { t: number; size: number }): Axis {
	const pos = t * (size - 1);
	const i0 = Math.min(Math.max(Math.floor(pos), 0), size - 1);
	return { i0, i1: Math.min(i0 + 1, size - 1), frac: pos - i0 };
}

function sample1d({ lut, rgb }: { lut: CubeLut; rgb: Rgb }): Rgb {
	const out: Rgb = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		const t = normaliseChannel({
			value: rgb[c],
			min: lut.domainMin[c],
			max: lut.domainMax[c],
		});
		const { i0, i1, frac } = axisPosition({ t, size: lut.size });
		const a = lut.table[i0 * 3 + c];
		const b = lut.table[i1 * 3 + c];
		out[c] = a + (b - a) * frac;
	}
	return out;
}

function sample3d({ lut, rgb }: { lut: CubeLut; rgb: Rgb }): Rgb {
	const { size, table } = lut;
	const ar = axisPosition({
		t: normaliseChannel({ value: rgb[0], min: lut.domainMin[0], max: lut.domainMax[0] }),
		size,
	});
	const ag = axisPosition({
		t: normaliseChannel({ value: rgb[1], min: lut.domainMin[1], max: lut.domainMax[1] }),
		size,
	});
	const ab = axisPosition({
		t: normaliseChannel({ value: rgb[2], min: lut.domainMin[2], max: lut.domainMax[2] }),
		size,
	});

	const corner = ({ r, g, b }: { r: number; g: number; b: number }): Rgb =>
		node3d({ table, size, r, g, b });

	// Interpolate along red, then green, then blue.
	const c00 = lerp3({
		a: corner({ r: ar.i0, g: ag.i0, b: ab.i0 }),
		b: corner({ r: ar.i1, g: ag.i0, b: ab.i0 }),
		t: ar.frac,
	});
	const c10 = lerp3({
		a: corner({ r: ar.i0, g: ag.i1, b: ab.i0 }),
		b: corner({ r: ar.i1, g: ag.i1, b: ab.i0 }),
		t: ar.frac,
	});
	const c01 = lerp3({
		a: corner({ r: ar.i0, g: ag.i0, b: ab.i1 }),
		b: corner({ r: ar.i1, g: ag.i0, b: ab.i1 }),
		t: ar.frac,
	});
	const c11 = lerp3({
		a: corner({ r: ar.i0, g: ag.i1, b: ab.i1 }),
		b: corner({ r: ar.i1, g: ag.i1, b: ab.i1 }),
		t: ar.frac,
	});

	const c0 = lerp3({ a: c00, b: c10, t: ag.frac });
	const c1 = lerp3({ a: c01, b: c11, t: ag.frac });
	return lerp3({ a: c0, b: c1, t: ab.frac });
}

/**
 * Sample a parsed `.cube` LUT at one RGB colour. 1D LUTs apply each channel's
 * curve independently; 3D LUTs trilinearly interpolate the eight surrounding
 * grid nodes. See the module header for the domain/clamp behaviour.
 */
export function sampleCubeLut({ lut, rgb }: { lut: CubeLut; rgb: Rgb }): Rgb {
	return lut.type === "1d" ? sample1d({ lut, rgb }) : sample3d({ lut, rgb });
}
