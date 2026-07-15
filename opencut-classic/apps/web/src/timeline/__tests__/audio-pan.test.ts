import { describe, expect, test } from "bun:test";
import type { AudioCapableElement } from "@/timeline/audio-state";
import {
	clampPan,
	getElementPan,
	panToChannelGains,
} from "@/timeline/audio-pan";

// The pan helpers have no wasm dependency (audio-pan.ts only imports a type),
// so this suite runs without stubbing @/wasm. The pan helpers read only
// `params.pan`, so a bare params bag stands in for a full audio element.
function elementWith(
	params: Record<string, number | string | boolean>,
): AudioCapableElement {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: only params is read
	return { params } as AudioCapableElement;
}

describe("clampPan", () => {
	test("passes values already inside [-1, 1]", () => {
		expect(clampPan({ value: 0 })).toBe(0);
		expect(clampPan({ value: 0.5 })).toBe(0.5);
		expect(clampPan({ value: -0.5 })).toBe(-0.5);
	});

	test("clamps out-of-range values to the hard edges", () => {
		expect(clampPan({ value: 2 })).toBe(1);
		expect(clampPan({ value: -3 })).toBe(-1);
	});

	test("falls back to centre for non-finite input", () => {
		expect(clampPan({ value: Number.NaN })).toBe(0);
		expect(clampPan({ value: Number.POSITIVE_INFINITY })).toBe(0);
	});
});

describe("panToChannelGains", () => {
	test("centre is an exact identity (existing projects unchanged)", () => {
		expect(panToChannelGains({ pan: 0 })).toEqual({ left: 1, right: 1 });
	});

	test("hard left mutes the right channel, leaves left at unity", () => {
		expect(panToChannelGains({ pan: -1 })).toEqual({ left: 1, right: 0 });
	});

	test("hard right mutes the left channel, leaves right at unity", () => {
		expect(panToChannelGains({ pan: 1 })).toEqual({ left: 0, right: 1 });
	});

	test("partial pan attenuates only the opposite channel, linearly", () => {
		expect(panToChannelGains({ pan: 0.5 })).toEqual({ left: 0.5, right: 1 });
		expect(panToChannelGains({ pan: -0.25 })).toEqual({ left: 1, right: 0.75 });
	});

	test("clamps out-of-range pan before computing gains", () => {
		expect(panToChannelGains({ pan: 5 })).toEqual({ left: 0, right: 1 });
		expect(panToChannelGains({ pan: -5 })).toEqual({ left: 1, right: 0 });
	});

	test("the near channel is always unity — a pan never boosts", () => {
		for (const pan of [-1, -0.5, -0.1, 0, 0.1, 0.5, 1]) {
			const { left, right } = panToChannelGains({ pan });
			expect(Math.max(left, right)).toBe(1);
			expect(left).toBeGreaterThanOrEqual(0);
			expect(right).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("getElementPan", () => {
	test("defaults to centre when params has no pan", () => {
		expect(getElementPan({ element: elementWith({ volume: 0 }) })).toBe(0);
	});

	test("reads a numeric pan from params", () => {
		expect(getElementPan({ element: elementWith({ pan: 0.5 }) })).toBe(0.5);
		expect(getElementPan({ element: elementWith({ pan: -1 }) })).toBe(-1);
	});

	test("clamps a stored pan outside the valid range", () => {
		expect(getElementPan({ element: elementWith({ pan: 4 }) })).toBe(1);
	});

	test("ignores a non-numeric pan value", () => {
		expect(getElementPan({ element: elementWith({ pan: "left" }) })).toBe(0);
	});
});
