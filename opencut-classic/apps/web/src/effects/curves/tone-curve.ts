/**
 * Tone-curve evaluation (COL-005). A curve is a set of control points the user
 * drags; this samples a smooth, **monotonicity-preserving** cubic through them
 * (Fritsch–Carlson) into a 1D LUT the colour pipeline can apply. Monotonic
 * interpolation matters for tone curves: a plain cubic spline overshoots between
 * points, which would invert or clip tones.
 *
 * Pure math over `{x, y}` points in [0, 1] — no GPU, no I/O — so it unit-tests
 * directly. The GPU side (uploading the LUT and sampling it in a shader) is the
 * separate follow-up.
 */

export interface CurvePoint {
	x: number;
	y: number;
}

export interface PreparedToneCurve {
	xs: number[];
	ys: number[];
	/** Monotone tangents, one per point. */
	tangents: number[];
}

/**
 * Validate, sort, de-duplicate, and compute monotone tangents for a curve.
 * Fewer than two distinct points collapses to a constant.
 */
export function prepareToneCurve({
	points,
}: {
	points: CurvePoint[];
}): PreparedToneCurve {
	const sorted = [...points].sort((a, b) => a.x - b.x);
	const xs: number[] = [];
	const ys: number[] = [];
	for (const point of sorted) {
		// Drop duplicate x (a vertical segment is not a function).
		if (xs.length > 0 && point.x === xs[xs.length - 1]) {
			continue;
		}
		xs.push(point.x);
		ys.push(point.y);
	}

	const n = xs.length;
	const tangents = new Array<number>(n).fill(0);
	if (n < 2) {
		return { xs, ys, tangents };
	}

	const slopes = new Array<number>(n - 1);
	for (let i = 0; i < n - 1; i++) {
		slopes[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
	}

	tangents[0] = slopes[0];
	tangents[n - 1] = slopes[n - 2];
	for (let i = 1; i < n - 1; i++) {
		// Zero the tangent at a local extremum (slopes change sign) to avoid
		// overshoot; otherwise average the neighbouring secant slopes.
		tangents[i] =
			slopes[i - 1] * slopes[i] <= 0
				? 0
				: (slopes[i - 1] + slopes[i]) / 2;
	}

	// Fritsch–Carlson: pull tangents into the monotone region.
	for (let i = 0; i < n - 1; i++) {
		if (slopes[i] === 0) {
			tangents[i] = 0;
			tangents[i + 1] = 0;
			continue;
		}
		const alpha = tangents[i] / slopes[i];
		const beta = tangents[i + 1] / slopes[i];
		const magnitude = alpha * alpha + beta * beta;
		if (magnitude > 9) {
			const tau = 3 / Math.sqrt(magnitude);
			tangents[i] = tau * alpha * slopes[i];
			tangents[i + 1] = tau * beta * slopes[i];
		}
	}

	return { xs, ys, tangents };
}

/** Evaluate a prepared curve at `x` (clamped to its domain). */
export function evaluateToneCurve({
	curve,
	x,
}: {
	curve: PreparedToneCurve;
	x: number;
}): number {
	const { xs, ys, tangents } = curve;
	const n = xs.length;
	if (n === 0) {
		return x;
	}
	if (n === 1 || x <= xs[0]) {
		return ys[0];
	}
	if (x >= xs[n - 1]) {
		return ys[n - 1];
	}

	// Binary search for the segment containing x.
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= x) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	const h = xs[hi] - xs[lo];
	const t = (x - xs[lo]) / h;
	const t2 = t * t;
	const t3 = t2 * t;
	const h00 = 2 * t3 - 3 * t2 + 1;
	const h10 = t3 - 2 * t2 + t;
	const h01 = -2 * t3 + 3 * t2;
	const h11 = t3 - t2;
	return (
		h00 * ys[lo] +
		h10 * h * tangents[lo] +
		h01 * ys[hi] +
		h11 * h * tangents[hi]
	);
}

/**
 * Sample the curve into a `size`-entry LUT over the input range `[0, 1]`. Each
 * output is clamped to `[0, 1]` (tones stay in range). This is the array a
 * shader would upload as a 1D texture.
 */
export function sampleToneCurve({
	points,
	size,
}: {
	points: CurvePoint[];
	size: number;
}): Float32Array {
	if (size < 2) {
		throw new Error("sampleToneCurve: size must be >= 2");
	}
	const curve = prepareToneCurve({ points });
	const lut = new Float32Array(size);
	for (let i = 0; i < size; i++) {
		const x = i / (size - 1);
		const y = evaluateToneCurve({ curve, x });
		lut[i] = y < 0 ? 0 : y > 1 ? 1 : y;
	}
	return lut;
}
