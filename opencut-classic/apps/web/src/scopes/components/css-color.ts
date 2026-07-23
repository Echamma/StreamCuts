/**
 * Resolve a CSS variable value (as returned by `getComputedStyle`) to concrete
 * 8-bit RGB. The browser normalises most colours to `rgb(...)` at compute time,
 * so that path handles the common case; the HSL fallback covers browsers that
 * preserve the source form.
 */
export function parseCssRgb({
	input,
}: {
	input: string;
}): [number, number, number] | null {
	if (!input) return null;
	const rgbMatch = input.match(/rgba?\(([^)]+)\)/);
	if (rgbMatch) {
		const parts = rgbMatch[1]!.split(",").map((s) => Number.parseFloat(s));
		if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
			return [
				Math.round(parts[0]!),
				Math.round(parts[1]!),
				Math.round(parts[2]!),
			];
		}
	}
	const hslMatch = input.match(
		/hsl\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/,
	);
	if (hslMatch) {
		const h = Number.parseFloat(hslMatch[1]!) / 360;
		const s = Number.parseFloat(hslMatch[2]!) / 100;
		const l = Number.parseFloat(hslMatch[3]!) / 100;
		const [r, g, b] = hslToRgb({ h, s, l });
		return [
			Math.round(r * 255),
			Math.round(g * 255),
			Math.round(b * 255),
		];
	}
	return null;
}

function hslToRgb({
	h,
	s,
	l,
}: {
	h: number;
	s: number;
	l: number;
}): [number, number, number] {
	if (s === 0) return [l, l, l];
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hueToRgb = (t: number): number => {
		let tt = t;
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};
	return [hueToRgb(h + 1 / 3), hueToRgb(h), hueToRgb(h - 1 / 3)];
}

/**
 * Read a CSS variable off an element and return concrete RGB, falling back to
 * a caller-supplied triple if the variable is missing or unparseable.
 */
export function readCssVarRgb({
	element,
	variable,
	fallback,
}: {
	element: Element;
	variable: string;
	fallback: [number, number, number];
}): [number, number, number] {
	const value = getComputedStyle(element).getPropertyValue(variable).trim();
	return parseCssRgb({ input: value }) ?? fallback;
}
