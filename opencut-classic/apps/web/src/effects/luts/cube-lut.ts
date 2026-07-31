/**
 * Parser for Adobe/IRIDAS `.cube` colour LUTs (COL-008). Pure text → typed
 * table, no I/O and no GPU — the shader that samples the LUT is a separate,
 * GPU-side concern; this module is the verifiable front half (import, validate,
 * normalise), and it unit-tests directly.
 *
 * Supports both `LUT_1D_SIZE` and `LUT_3D_SIZE`. Comments (`#`), `TITLE`, and
 * `DOMAIN_MIN`/`DOMAIN_MAX` are honoured; blank lines are ignored. For 3D LUTs
 * the entries are ordered with red fastest (the `.cube` convention).
 */

export type CubeLutType = "1d" | "3d";

export interface CubeLut {
	type: CubeLutType;
	/** Entries per axis. A 3D LUT has `size**3` rows; a 1D LUT has `size`. */
	size: number;
	title: string | null;
	domainMin: [number, number, number];
	domainMax: [number, number, number];
	/** Flat RGB triples: `row * 3 + {0,1,2}`. Length = rows * 3. */
	table: Float32Array;
}

const DEFAULT_DOMAIN_MIN: [number, number, number] = [0, 0, 0];
const DEFAULT_DOMAIN_MAX: [number, number, number] = [1, 1, 1];

function parseTriple({
	tokens,
	context,
}: {
	tokens: string[];
	context: string;
}): [number, number, number] {
	if (tokens.length !== 3) {
		throw new Error(`${context}: expected 3 numbers, got ${tokens.length}`);
	}
	const values = tokens.map((token) => Number(token));
	if (values.some((value) => !Number.isFinite(value))) {
		throw new Error(`${context}: non-numeric value in "${tokens.join(" ")}"`);
	}
	return [values[0], values[1], values[2]];
}

/** Parse `.cube` text into a {@link CubeLut}. Throws on malformed input. */
export function parseCubeLut({ text }: { text: string }): CubeLut {
	let type: CubeLutType | null = null;
	let size = 0;
	let title: string | null = null;
	let domainMin = DEFAULT_DOMAIN_MIN;
	let domainMax = DEFAULT_DOMAIN_MAX;
	const rows: number[] = [];

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}

		const tokens = line.split(/\s+/);
		const keyword = tokens[0].toUpperCase();

		switch (keyword) {
			case "TITLE": {
				// Everything after TITLE, stripped of surrounding quotes.
				title = line.slice("TITLE".length).trim().replace(/^"|"$/g, "");
				break;
			}
			case "LUT_1D_SIZE":
			case "LUT_3D_SIZE": {
				const parsed = Number(tokens[1]);
				if (!Number.isInteger(parsed) || parsed < 2) {
					throw new Error(`${keyword}: invalid size "${tokens[1] ?? ""}"`);
				}
				type = keyword === "LUT_1D_SIZE" ? "1d" : "3d";
				size = parsed;
				break;
			}
			case "DOMAIN_MIN": {
				domainMin = parseTriple({ tokens: tokens.slice(1), context: "DOMAIN_MIN" });
				break;
			}
			case "DOMAIN_MAX": {
				domainMax = parseTriple({ tokens: tokens.slice(1), context: "DOMAIN_MAX" });
				break;
			}
			default: {
				const triple = parseTriple({ tokens, context: "LUT entry" });
				rows.push(triple[0], triple[1], triple[2]);
			}
		}
	}

	if (type === null) {
		throw new Error("Missing LUT_1D_SIZE or LUT_3D_SIZE.");
	}

	const expectedRows = type === "3d" ? size ** 3 : size;
	if (rows.length !== expectedRows * 3) {
		throw new Error(
			`Expected ${expectedRows} LUT entries for ${type} size ${size}, got ${rows.length / 3}.`,
		);
	}

	return {
		type,
		size,
		title,
		domainMin,
		domainMax,
		table: Float32Array.from(rows),
	};
}
