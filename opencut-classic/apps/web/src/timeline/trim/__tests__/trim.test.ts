import { describe, expect, mock, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";

// The trim math leans on `@/wasm` MediaTime helpers, whose wasm-bindgen binary
// cannot instantiate under `bun test` (same constraint the caption render test
// documents). We stub `@/wasm` with faithful pure-JS implementations — unlike
// that render test's identity stubs, these preserve real clamp / frame-round /
// round-half-away-from-zero semantics, because clamping and snapping are exactly
// what this suite verifies. `@/retime` is left real: it is pure rate arithmetic
// with no wasm dependency.
const TPS = 120000;
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: TPS,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => {
		const rounded = Math.round(Math.abs(time));
		return rounded === 0 ? 0 : time < 0 ? -rounded : rounded;
	},
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
	clampMediaTime: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => (time < min ? min : time > max ? max : time),
	roundFrameTicks: ({ ticks, fps }: { ticks: number; fps: FrameRate }) => {
		const frame = (TPS * fps.denominator) / fps.numerator;
		return Math.round(ticks / frame) * frame;
	},
}));

// Imported after the mock so no real wasm binary is instantiated. `mediaTime`
// is typed as returning branded `MediaTime` (tsc sees the real declaration),
// so fixtures build valid `TrimClip`s with no casts even though at runtime the
// stub returns a bare number.
const { mediaTime } = await import("@/wasm");
const { computeSlip } = await import("@/timeline/trim/slip");
const { computeRoll } = await import("@/timeline/trim/roll");
const { computeSlide } = await import("@/timeline/trim/slide");
const { findLeftAdjacentId, findRightAdjacentId } = await import(
	"@/timeline/trim/adjacency"
);
type TrimClip = import("@/timeline/trim/types").TrimClip;
type TrimPatch = import("@/timeline/trim/types").TrimPatch;

const fps30: FrameRate = { numerator: 30, denominator: 1 };
const FRAME = TPS / 30; // 4000 ticks at 30fps

interface ClipParams {
	startTime?: number;
	duration?: number;
	trimStart?: number;
	trimEnd?: number;
	sourceDuration?: number;
	retime?: { rate: number; maintainPitch?: boolean };
}

function clip(params: ClipParams = {}): TrimClip {
	const startTime = params.startTime ?? 0;
	const duration = params.duration ?? 10 * FRAME;
	const trimStart = params.trimStart ?? 0;
	const trimEnd = params.trimEnd ?? 0;
	const sourceDuration = "sourceDuration" in params ? params.sourceDuration : duration;
	return {
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: trimStart }),
		trimEnd: mediaTime({ ticks: trimEnd }),
		sourceDuration:
			sourceDuration === undefined
				? undefined
				: mediaTime({ ticks: sourceDuration }),
		retime: params.retime,
	};
}

/** Merge a patch onto its base clip; MediaTime reads freely as a number. */
function apply({ base, patch }: { base: TrimClip; patch: TrimPatch }) {
	return {
		startTime: patch.startTime ?? base.startTime,
		duration: patch.duration ?? base.duration,
		trimStart: patch.trimStart ?? base.trimStart,
		trimEnd: patch.trimEnd ?? base.trimEnd,
		sourceDuration: base.sourceDuration,
		rate: base.retime?.rate ?? 1,
	};
}

/** The stored invariant: trimStart + duration*rate + trimEnd === sourceDuration. */
function invariantHolds({
	merged,
}: {
	merged: ReturnType<typeof apply>;
}): boolean {
	if (merged.sourceDuration === undefined) return true;
	return (
		merged.trimStart + merged.duration * merged.rate + merged.trimEnd ===
		merged.sourceDuration
	);
}

describe("computeSlip", () => {
	test("shifts the source window later, preserving position and duration", () => {
		const c = clip({
			startTime: 5 * FRAME,
			duration: 10 * FRAME,
			trimStart: 2 * FRAME,
			trimEnd: 2 * FRAME,
			sourceDuration: 14 * FRAME,
		});
		const result = computeSlip({
			clip: c,
			requestedDelta: mediaTime({ ticks: FRAME }),
			fps: fps30,
		});
		expect(result).not.toBeNull();
		expect(result?.appliedSource).toBe(FRAME);
		expect(result?.patch.trimStart).toBe(3 * FRAME);
		expect(result?.patch.trimEnd).toBe(FRAME);
		// startTime / duration are untouched by a slip.
		expect(result?.patch.startTime).toBeUndefined();
		expect(result?.patch.duration).toBeUndefined();
		expect(invariantHolds({ merged: apply({ base: c, patch: result!.patch }) })).toBe(
			true,
		);
	});

	test("clamps to the available tail handle", () => {
		const c = clip({
			duration: 10 * FRAME,
			trimStart: 2 * FRAME,
			trimEnd: 2 * FRAME,
			sourceDuration: 14 * FRAME,
		});
		const result = computeSlip({
			clip: c,
			requestedDelta: mediaTime({ ticks: 5 * FRAME }),
			fps: fps30,
		});
		expect(result?.appliedSource).toBe(2 * FRAME); // capped at trimEnd
		expect(result?.patch.trimStart).toBe(4 * FRAME);
		expect(result?.patch.trimEnd).toBe(0);
		expect(invariantHolds({ merged: apply({ base: c, patch: result!.patch }) })).toBe(
			true,
		);
	});

	test("clamps to the available head handle when slipping earlier", () => {
		const c = clip({
			duration: 10 * FRAME,
			trimStart: 2 * FRAME,
			trimEnd: 2 * FRAME,
			sourceDuration: 14 * FRAME,
		});
		const result = computeSlip({
			clip: c,
			requestedDelta: mediaTime({ ticks: -5 * FRAME }),
			fps: fps30,
		});
		expect(result?.appliedSource).toBe(-2 * FRAME); // capped at -trimStart
		expect(result?.patch.trimStart).toBe(0);
		expect(result?.patch.trimEnd).toBe(4 * FRAME);
		expect(invariantHolds({ merged: apply({ base: c, patch: result!.patch }) })).toBe(
			true,
		);
	});

	test("returns null when there is no handle to slip into", () => {
		const c = clip({ trimStart: 0, trimEnd: 0 });
		expect(
			computeSlip({
				clip: c,
				requestedDelta: mediaTime({ ticks: FRAME }),
				fps: fps30,
			}),
		).toBeNull();
	});

	test("scales the clip-space delta into source space under retime", () => {
		const c = clip({
			duration: 10 * FRAME,
			trimStart: 4 * FRAME,
			trimEnd: 4 * FRAME,
			// srcDur = trimStart + duration*rate + trimEnd = 4f + 20f + 4f = 28f
			sourceDuration: 28 * FRAME,
			retime: { rate: 2 },
		});
		const result = computeSlip({
			clip: c,
			requestedDelta: mediaTime({ ticks: FRAME }),
			fps: fps30,
		});
		// 1 clip frame * rate 2 = 2 source frames.
		expect(result?.appliedSource).toBe(2 * FRAME);
		expect(result?.patch.trimStart).toBe(6 * FRAME);
		expect(result?.patch.trimEnd).toBe(2 * FRAME);
		expect(invariantHolds({ merged: apply({ base: c, patch: result!.patch }) })).toBe(
			true,
		);
	});
});

describe("computeRoll", () => {
	// A ends where B begins (touching); both have handles on the rolled sides.
	const left = clip({
		startTime: 0,
		duration: 10 * FRAME,
		trimStart: FRAME,
		trimEnd: 2 * FRAME,
		sourceDuration: 13 * FRAME,
	});
	const right = clip({
		startTime: 10 * FRAME,
		duration: 10 * FRAME,
		trimStart: 2 * FRAME,
		trimEnd: FRAME,
		sourceDuration: 13 * FRAME,
	});

	test("moves the edit point later: left grows, right shrinks and starts later", () => {
		const result = computeRoll({
			left,
			right,
			requestedDelta: mediaTime({ ticks: FRAME }),
			fps: fps30,
		});
		expect(result).not.toBeNull();
		expect(result?.applied).toBe(FRAME);
		// left grows to 11f (ends at 11f); right starts at 11f — stays gapless.
		expect(result?.left).toEqual({ duration: 11 * FRAME, trimEnd: FRAME });
		expect(result?.right).toEqual({
			startTime: 11 * FRAME,
			duration: 9 * FRAME,
			trimStart: 3 * FRAME,
		});
		expect(invariantHolds({ merged: apply({ base: left, patch: result!.left }) })).toBe(
			true,
		);
		expect(
			invariantHolds({ merged: apply({ base: right, patch: result!.right }) }),
		).toBe(true);
	});

	test("moves the edit point earlier: left shrinks, right grows and starts earlier", () => {
		const result = computeRoll({
			left,
			right,
			requestedDelta: mediaTime({ ticks: -FRAME }),
			fps: fps30,
		});
		expect(result?.applied).toBe(-FRAME);
		expect(result?.left).toEqual({ duration: 9 * FRAME, trimEnd: 3 * FRAME });
		expect(result?.right).toEqual({
			startTime: 9 * FRAME,
			duration: 11 * FRAME,
			trimStart: FRAME,
		});
		expect(invariantHolds({ merged: apply({ base: left, patch: result!.left }) })).toBe(
			true,
		);
		expect(
			invariantHolds({ merged: apply({ base: right, patch: result!.right }) }),
		).toBe(true);
	});

	test("clamps forward roll to the left clip's source tail", () => {
		// left.trimEnd is 2 frames → at most 2 frames of forward roll.
		const result = computeRoll({
			left,
			right,
			requestedDelta: mediaTime({ ticks: 5 * FRAME }),
			fps: fps30,
		});
		expect(result?.applied).toBe(2 * FRAME);
		expect(result?.left.trimEnd).toBe(0);
		expect(invariantHolds({ merged: apply({ base: left, patch: result!.left }) })).toBe(
			true,
		);
		expect(
			invariantHolds({ merged: apply({ base: right, patch: result!.right }) }),
		).toBe(true);
	});

	test("clamps backward roll to the right clip's source head", () => {
		// right.trimStart is 2 frames → at most 2 frames of backward roll.
		const result = computeRoll({
			left,
			right,
			requestedDelta: mediaTime({ ticks: -5 * FRAME }),
			fps: fps30,
		});
		expect(result?.applied).toBe(-2 * FRAME);
		expect(result?.right.trimStart).toBe(0);
		expect(invariantHolds({ merged: apply({ base: left, patch: result!.left }) })).toBe(
			true,
		);
		expect(
			invariantHolds({ merged: apply({ base: right, patch: result!.right }) }),
		).toBe(true);
	});

	test("clamps to the shrinking clip's one-frame minimum", () => {
		const shortRight = clip({
			startTime: 10 * FRAME,
			duration: 2 * FRAME,
			trimStart: 4 * FRAME,
			trimEnd: FRAME,
			sourceDuration: 7 * FRAME,
		});
		const longTailLeft = clip({
			startTime: 0,
			duration: 10 * FRAME,
			trimStart: FRAME,
			trimEnd: 8 * FRAME,
			sourceDuration: 19 * FRAME,
		});
		const result = computeRoll({
			left: longTailLeft,
			right: shortRight,
			requestedDelta: mediaTime({ ticks: 5 * FRAME }),
			fps: fps30,
		});
		// right can only shrink by 1 frame (2 → 1 frame minimum).
		expect(result?.applied).toBe(FRAME);
		expect(result?.right.duration).toBe(FRAME);
	});

	test("treats a sourceless left clip as having unlimited tail", () => {
		const textLeft = clip({
			startTime: 0,
			duration: 10 * FRAME,
			trimStart: 0,
			trimEnd: 0,
			sourceDuration: undefined,
		});
		const result = computeRoll({
			left: textLeft,
			right,
			requestedDelta: mediaTime({ ticks: 3 * FRAME }),
			fps: fps30,
		});
		// No source-tail cap; bounded only by right's shrink room (plenty).
		expect(result?.applied).toBe(3 * FRAME);
		expect(result?.left.duration).toBe(13 * FRAME);
		expect(result?.left.trimEnd).toBe(0); // clamped, never negative
	});

	test("returns null when the clips are not adjacent", () => {
		const gapped = clip({ startTime: 11 * FRAME, duration: 10 * FRAME });
		expect(
			computeRoll({
				left,
				right: gapped,
				requestedDelta: mediaTime({ ticks: FRAME }),
				fps: fps30,
			}),
		).toBeNull();
	});

	test("returns null for a zero-delta roll", () => {
		expect(
			computeRoll({
				left,
				right,
				requestedDelta: mediaTime({ ticks: 0 }),
				fps: fps30,
			}),
		).toBeNull();
	});
});

describe("computeSlide", () => {
	const left = clip({
		startTime: 0,
		duration: 10 * FRAME,
		trimStart: FRAME,
		trimEnd: 2 * FRAME,
		sourceDuration: 13 * FRAME,
	});
	const target = clip({
		startTime: 10 * FRAME,
		duration: 10 * FRAME,
		trimStart: 3 * FRAME,
		trimEnd: 3 * FRAME,
		sourceDuration: 16 * FRAME,
	});
	const right = clip({
		startTime: 20 * FRAME,
		duration: 10 * FRAME,
		trimStart: 2 * FRAME,
		trimEnd: FRAME,
		sourceDuration: 13 * FRAME,
	});

	test("slides the clip later; neighbours absorb it and it keeps its own trims", () => {
		const result = computeSlide({
			left,
			target,
			right,
			requestedDelta: mediaTime({ ticks: FRAME }),
			fps: fps30,
		});
		expect(result).not.toBeNull();
		expect(result?.applied).toBe(FRAME);
		// Target only moves; its source window is untouched. left ends at 11f,
		// target runs 11f→21f, right starts at 21f — everything stays gapless.
		expect(result?.target).toEqual({ startTime: 11 * FRAME });
		expect(result?.left).toEqual({ duration: 11 * FRAME, trimEnd: FRAME });
		expect(result?.right).toEqual({
			startTime: 21 * FRAME,
			duration: 9 * FRAME,
			trimStart: 3 * FRAME,
		});
		expect(invariantHolds({ merged: apply({ base: left, patch: result!.left }) })).toBe(
			true,
		);
		expect(
			invariantHolds({ merged: apply({ base: right, patch: result!.right }) }),
		).toBe(true);
	});

	test("clamps a forward slide to the left neighbour's source tail", () => {
		const result = computeSlide({
			left,
			target,
			right,
			requestedDelta: mediaTime({ ticks: 9 * FRAME }),
			fps: fps30,
		});
		expect(result?.applied).toBe(2 * FRAME); // left.trimEnd
		expect(result?.left.trimEnd).toBe(0);
	});

	test("clamps a backward slide to the right neighbour's source head", () => {
		const result = computeSlide({
			left,
			target,
			right,
			requestedDelta: mediaTime({ ticks: -9 * FRAME }),
			fps: fps30,
		});
		expect(result?.applied).toBe(-2 * FRAME); // right.trimStart
		expect(result?.right.trimStart).toBe(0);
	});

	test("returns null when the right neighbour is not adjacent", () => {
		const gappedRight = clip({ startTime: 21 * FRAME, duration: 10 * FRAME });
		expect(
			computeSlide({
				left,
				target,
				right: gappedRight,
				requestedDelta: mediaTime({ ticks: FRAME }),
				fps: fps30,
			}),
		).toBeNull();
	});

	test("returns null for a zero-delta slide", () => {
		expect(
			computeSlide({
				left,
				target,
				right,
				requestedDelta: mediaTime({ ticks: 0 }),
				fps: fps30,
			}),
		).toBeNull();
	});
});

describe("adjacency finders", () => {
	const elements = [
		{ id: "a", startTime: mediaTime({ ticks: 0 }), duration: mediaTime({ ticks: 10 * FRAME }) },
		{
			id: "b",
			startTime: mediaTime({ ticks: 10 * FRAME }),
			duration: mediaTime({ ticks: 10 * FRAME }),
		},
		{
			id: "c",
			startTime: mediaTime({ ticks: 25 * FRAME }), // gap before c
			duration: mediaTime({ ticks: 5 * FRAME }),
		},
	];

	test("finds the touching left neighbour", () => {
		expect(findLeftAdjacentId({ elements, elementId: "b" })).toBe("a");
	});

	test("finds the touching right neighbour", () => {
		expect(findRightAdjacentId({ elements, elementId: "a" })).toBe("b");
	});

	test("returns null across a gap", () => {
		expect(findRightAdjacentId({ elements, elementId: "b" })).toBeNull();
		expect(findLeftAdjacentId({ elements, elementId: "c" })).toBeNull();
	});

	test("returns null for an unknown element", () => {
		expect(findLeftAdjacentId({ elements, elementId: "x" })).toBeNull();
	});
});
