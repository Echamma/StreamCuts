import { describe, expect, test } from "bun:test";
import { parseCubeLut } from "@/effects/luts/cube-lut";
import { type Rgb, sampleCubeLut } from "@/effects/luts/sample-cube-lut";

// Both modules are pure — no @/wasm, no stub needed.

/** Identity 3D LUT: every grid node holds its own coordinate, so trilinear
 * sampling is exact identity. */
const IDENTITY_3D = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

/** 3D LUT that swaps the red and blue channels — node(r,g,b) = (b,g,r). Still
 * linear, so trilinear interpolation stays exact. */
const SWAP_RB_3D = `LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`;

function closeTo({ actual, expected }: { actual: Rgb; expected: Rgb }): void {
	for (let c = 0; c < 3; c++) {
		expect(actual[c]).toBeCloseTo(expected[c], 6);
	}
}

describe("sampleCubeLut — 3D", () => {
	test("identity LUT returns the input colour (trilinear exact)", () => {
		const lut = parseCubeLut({ text: IDENTITY_3D });
		closeTo({
			actual: sampleCubeLut({ lut, rgb: [0.3, 0.6, 0.9] }),
			expected: [0.3, 0.6, 0.9],
		});
	});

	test("returns exact grid nodes at the corners", () => {
		const lut = parseCubeLut({ text: IDENTITY_3D });
		closeTo({ actual: sampleCubeLut({ lut, rgb: [0, 0, 0] }), expected: [0, 0, 0] });
		closeTo({ actual: sampleCubeLut({ lut, rgb: [1, 1, 1] }), expected: [1, 1, 1] });
	});

	test("swap-RB LUT exchanges red and blue", () => {
		const lut = parseCubeLut({ text: SWAP_RB_3D });
		closeTo({
			actual: sampleCubeLut({ lut, rgb: [0.2, 0.5, 0.8] }),
			expected: [0.8, 0.5, 0.2],
		});
	});

	test("clamps colours outside [0, 1] to the LUT edges", () => {
		const lut = parseCubeLut({ text: IDENTITY_3D });
		closeTo({
			actual: sampleCubeLut({ lut, rgb: [-0.5, 1.5, 0.5] }),
			expected: [0, 1, 0.5],
		});
	});

	test("normalises the input through DOMAIN_MAX", () => {
		// Identity nodes but a 0..2 input domain → an input of 1 is mid-domain.
		const lut = parseCubeLut({
			text: `LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n${IDENTITY_3D.split("\n").slice(1).join("\n")}`,
		});
		closeTo({
			actual: sampleCubeLut({ lut, rgb: [1, 1, 1] }),
			expected: [0.5, 0.5, 0.5],
		});
	});
});

describe("sampleCubeLut — 1D", () => {
	test("applies each channel's curve independently", () => {
		// R curve nodes [0, 0.2, 1]; G and B stay linear [0, 0.5, 1].
		const lut = parseCubeLut({
			text: `LUT_1D_SIZE 3\n0 0 0\n0.2 0.5 0.5\n1 1 1\n`,
		});
		// Input 0.5 lands exactly on the middle node.
		closeTo({
			actual: sampleCubeLut({ lut, rgb: [0.5, 0.5, 0.5] }),
			expected: [0.2, 0.5, 0.5],
		});
	});

	test("interpolates between 1D nodes", () => {
		const lut = parseCubeLut({
			text: `LUT_1D_SIZE 3\n0 0 0\n0.2 0.5 0.5\n1 1 1\n`,
		});
		// 3 nodes span [0, 1] at inputs 0 / 0.5 / 1, so input 0.25 is halfway
		// between node0 (R 0) and node1 (R 0.2) → 0.1.
		const [r] = sampleCubeLut({ lut, rgb: [0.25, 0, 0] });
		expect(r).toBeCloseTo(0.1, 6);
	});
});
