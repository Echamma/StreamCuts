import { describe, expect, test } from "bun:test";
import {
	METER_FLOOR_DB,
	computeLevelsFromSamples,
	linearToDbfs,
	dbfsToFraction,
	linearToFraction,
	decayPeakHold,
} from "@/media/audio-metering";

describe("computeLevelsFromSamples", () => {
	test("peak is the max magnitude, rms is root-mean-square", () => {
		const { peak, rms } = computeLevelsFromSamples({
			samples: new Float32Array([0, 0.5, -1, 0.5]),
		});
		expect(peak).toBe(1);
		// sqrt((0 + 0.25 + 1 + 0.25)/4) = sqrt(0.375)
		expect(rms).toBeCloseTo(Math.sqrt(0.375), 10);
	});

	test("full-scale square wave reads peak 1 and rms 1", () => {
		const { peak, rms } = computeLevelsFromSamples({
			samples: new Float32Array([1, -1, 1, -1]),
		});
		expect(peak).toBe(1);
		expect(rms).toBeCloseTo(1, 10);
	});

	test("empty block reads silent", () => {
		expect(computeLevelsFromSamples({ samples: new Float32Array([]) })).toEqual({
			peak: 0,
			rms: 0,
		});
	});
});

describe("linearToDbfs", () => {
	test("unity is 0 dBFS", () => {
		expect(linearToDbfs({ value: 1 })).toBeCloseTo(0, 10);
	});

	test("half amplitude is about -6.02 dBFS", () => {
		expect(linearToDbfs({ value: 0.5 })).toBeCloseTo(-6.0206, 3);
	});

	test("silence is -Infinity", () => {
		expect(linearToDbfs({ value: 0 })).toBe(-Infinity);
		expect(linearToDbfs({ value: -0.3 })).toBe(-Infinity);
	});
});

describe("dbfsToFraction", () => {
	test("0 dBFS and hotter fill fully", () => {
		expect(dbfsToFraction({ dbfs: 0 })).toBe(1);
		expect(dbfsToFraction({ dbfs: 3 })).toBe(1);
	});

	test("floor and quieter read empty (incl. -Infinity)", () => {
		expect(dbfsToFraction({ dbfs: METER_FLOOR_DB })).toBe(0);
		expect(dbfsToFraction({ dbfs: -120 })).toBe(0);
		expect(dbfsToFraction({ dbfs: -Infinity })).toBe(0);
	});

	test("linear interpolation across the range", () => {
		// midpoint of [-60, 0] is -30 → 0.5
		expect(dbfsToFraction({ dbfs: -30 })).toBeCloseTo(0.5, 10);
		expect(dbfsToFraction({ dbfs: -15 })).toBeCloseTo(0.75, 10);
	});

	test("NaN guards to 0", () => {
		expect(dbfsToFraction({ dbfs: Number.NaN })).toBe(0);
	});

	test("honours a custom floor", () => {
		expect(dbfsToFraction({ dbfs: -20, floorDb: -40 })).toBeCloseTo(0.5, 10);
	});
});

describe("linearToFraction", () => {
	test("unity fills fully, silence empty", () => {
		expect(linearToFraction({ value: 1 })).toBe(1);
		expect(linearToFraction({ value: 0 })).toBe(0);
	});
});

describe("decayPeakHold", () => {
	test("snaps up instantly to a louder reading", () => {
		expect(decayPeakHold({ held: 0.2, current: 0.8, decay: 0.05 })).toBe(0.8);
	});

	test("decays toward a quieter reading by the decay step", () => {
		expect(decayPeakHold({ held: 0.8, current: 0.2, decay: 0.05 })).toBeCloseTo(
			0.75,
			10,
		);
	});

	test("never drops below the current reading", () => {
		expect(decayPeakHold({ held: 0.22, current: 0.2, decay: 0.05 })).toBe(0.2);
	});
});
