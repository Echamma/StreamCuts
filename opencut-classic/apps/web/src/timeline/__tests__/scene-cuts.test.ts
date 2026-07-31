import { describe, expect, test } from "bun:test";
import { sourceCutsToClipMarkerTicks } from "@/timeline/scene-cuts";

// Pure arithmetic (no @/wasm) — no stub needed.
const TPS = 120000;
const ticks = (seconds: number) => Math.round(seconds * TPS);

describe("sourceCutsToClipMarkerTicks", () => {
	test("maps in-range cuts to element-local ticks (rate 1)", () => {
		// Clip shows source from 1s, 6s long. Cuts at 2s and 5s source → local 1s/4s.
		expect(
			sourceCutsToClipMarkerTicks({
				cuts: [2, 5],
				trimStartSeconds: 1,
				durationTicks: ticks(6),
				ticksPerSecond: TPS,
			}),
		).toEqual([ticks(1), ticks(4)]);
	});

	test("drops cuts before the clip start and past its end", () => {
		expect(
			sourceCutsToClipMarkerTicks({
				cuts: [0.5, 2, 9],
				trimStartSeconds: 1,
				durationTicks: ticks(3), // covers source 1s..4s
				ticksPerSecond: TPS,
			}),
		).toEqual([ticks(1)]);
	});

	test("accounts for the retime rate", () => {
		// rate 2: source cut 5s, trimStart 1s → (5-1)/2 = 2s local.
		expect(
			sourceCutsToClipMarkerTicks({
				cuts: [5],
				trimStartSeconds: 1,
				durationTicks: ticks(6),
				ticksPerSecond: TPS,
				rate: 2,
			}),
		).toEqual([ticks(2)]);
	});

	test("sorts and de-duplicates", () => {
		expect(
			sourceCutsToClipMarkerTicks({
				cuts: [5, 2, 2],
				trimStartSeconds: 0,
				durationTicks: ticks(10),
				ticksPerSecond: TPS,
			}),
		).toEqual([ticks(2), ticks(5)]);
	});

	test("empty for a non-positive rate or no in-range cuts", () => {
		expect(
			sourceCutsToClipMarkerTicks({
				cuts: [5],
				trimStartSeconds: 0,
				durationTicks: ticks(4),
				ticksPerSecond: TPS,
				rate: 0,
			}),
		).toEqual([]);
		expect(
			sourceCutsToClipMarkerTicks({
				cuts: [9],
				trimStartSeconds: 0,
				durationTicks: ticks(4),
				ticksPerSecond: TPS,
			}),
		).toEqual([]);
	});
});
