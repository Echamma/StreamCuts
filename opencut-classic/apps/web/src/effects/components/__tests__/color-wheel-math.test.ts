import { describe, expect, test } from "bun:test";
import {
	balanceToPad,
	clampToDisc,
	padToBalance,
} from "@/effects/components/color-wheel-math";

// Pure geometry — no @/wasm dependency, so no mock needed.

describe("clampToDisc", () => {
	test("leaves points inside the disc untouched", () => {
		expect(clampToDisc({ point: { x: 0.3, y: -0.4 } })).toEqual({
			x: 0.3,
			y: -0.4,
		});
	});

	test("projects points outside the disc onto the rim", () => {
		const clamped = clampToDisc({ point: { x: 3, y: 4 } });
		expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(1, 10);
		// direction preserved
		expect(clamped.x / clamped.y).toBeCloseTo(3 / 4, 10);
	});
});

describe("padToBalance", () => {
	test("center is a neutral (zero) balance", () => {
		const b = padToBalance({ point: { x: 0, y: 0 }, amount: 0.5 });
		expect(b.r).toBeCloseTo(0, 10);
		expect(b.g).toBeCloseTo(0, 10);
		expect(b.b).toBeCloseTo(0, 10);
	});

	test("dragging up (toward red) boosts red and lowers green/blue", () => {
		const b = padToBalance({ point: { x: 0, y: 1 }, amount: 0.5 });
		expect(b.r).toBeCloseTo(0.5, 10);
		expect(b.g).toBeLessThan(0);
		expect(b.b).toBeLessThan(0);
		// zero-sum push
		expect(b.r + b.g + b.b).toBeCloseTo(0, 10);
	});

	test("amount scales the balance linearly", () => {
		const small = padToBalance({ point: { x: 0, y: 1 }, amount: 0.25 });
		const big = padToBalance({ point: { x: 0, y: 1 }, amount: 0.5 });
		expect(big.r).toBeCloseTo(small.r * 2, 10);
	});
});

describe("balanceToPad round-trips padToBalance", () => {
	test.each([
		{ x: 0, y: 0 },
		{ x: 0, y: 0.8 },
		{ x: -0.5, y: 0.3 },
		{ x: 0.6, y: -0.6 },
	])("point %j survives pad→balance→pad", (point: { x: number; y: number }) => {
		const amount = 0.5;
		const balance = padToBalance({ point, amount });
		const back = balanceToPad({ balance, amount });
		expect(back.x).toBeCloseTo(point.x, 6);
		expect(back.y).toBeCloseTo(point.y, 6);
	});

	test("amount 0 is a safe no-op (avoids divide-by-zero)", () => {
		expect(balanceToPad({ balance: { r: 0.1, g: 0, b: 0 }, amount: 0 })).toEqual({
			x: 0,
			y: 0,
		});
	});
});
