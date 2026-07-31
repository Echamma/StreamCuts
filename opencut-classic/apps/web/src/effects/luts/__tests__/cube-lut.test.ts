import { describe, expect, test } from "bun:test";
import { parseCubeLut } from "@/effects/luts/cube-lut";

// cube-lut.ts is pure text parsing — no @/wasm, no stub needed.

const IDENTITY_2X2X2 = `# a tiny identity LUT
TITLE "Sample"
LUT_3D_SIZE 2

0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

describe("parseCubeLut — 3D", () => {
	test("parses size, title, and all entries (red fastest)", () => {
		const lut = parseCubeLut({ text: IDENTITY_2X2X2 });
		expect(lut.type).toBe("3d");
		expect(lut.size).toBe(2);
		expect(lut.title).toBe("Sample");
		expect(lut.table).toHaveLength(8 * 3);
		// second entry is (1,0,0)
		expect([lut.table[3], lut.table[4], lut.table[5]]).toEqual([1, 0, 0]);
	});

	test("defaults the domain to 0..1 when unspecified", () => {
		const lut = parseCubeLut({ text: IDENTITY_2X2X2 });
		expect(lut.domainMin).toEqual([0, 0, 0]);
		expect(lut.domainMax).toEqual([1, 1, 1]);
	});

	test("honours DOMAIN_MIN / DOMAIN_MAX", () => {
		const lut = parseCubeLut({
			text: `LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 4 4 4\n${"0 0 0\n".repeat(8)}`,
		});
		expect(lut.domainMax).toEqual([4, 4, 4]);
	});

	test("ignores comments and blank lines", () => {
		const lut = parseCubeLut({
			text: `\n\n# header\nLUT_3D_SIZE 2\n\n${"0.5 0.5 0.5\n".repeat(8)}\n# trailing\n`,
		});
		expect(lut.table).toHaveLength(24);
		expect(lut.table[0]).toBeCloseTo(0.5, 6);
	});
});

describe("parseCubeLut — 1D", () => {
	test("parses a 1D LUT of `size` rows", () => {
		const lut = parseCubeLut({
			text: `LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\n`,
		});
		expect(lut.type).toBe("1d");
		expect(lut.size).toBe(3);
		expect(lut.table).toHaveLength(9);
	});
});

describe("parseCubeLut — errors", () => {
	test("throws when no size keyword is present", () => {
		expect(() => parseCubeLut({ text: "0 0 0\n1 1 1\n" })).toThrow(
			"Missing LUT_1D_SIZE or LUT_3D_SIZE",
		);
	});

	test("throws when the entry count does not match the size", () => {
		expect(() =>
			parseCubeLut({ text: `LUT_3D_SIZE 2\n0 0 0\n1 1 1\n` }),
		).toThrow("Expected 8 LUT entries");
	});

	test("throws on a non-numeric entry", () => {
		expect(() =>
			parseCubeLut({ text: `LUT_1D_SIZE 2\n0 0 0\nx y z\n` }),
		).toThrow("non-numeric");
	});

	test("throws on an invalid size", () => {
		expect(() => parseCubeLut({ text: `LUT_3D_SIZE 1\n0 0 0\n` })).toThrow(
			"invalid size",
		);
	});
});
