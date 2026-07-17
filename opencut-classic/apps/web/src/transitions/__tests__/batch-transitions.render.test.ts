import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import type { TransitionDefinition } from "@/transitions/types";
import { dipWhiteTransition } from "@/transitions/definitions/dip-white";
import { slideLeftTransition } from "@/transitions/definitions/slide-left";
import { pushLeftTransition } from "@/transitions/definitions/push-left";
import { zoomInTransition } from "@/transitions/definitions/zoom-in";
import { blurThroughTransition } from "@/transitions/definitions/blur-through";

// The transition definitions are dependency-free (type-only imports), so their
// render() can be exercised directly against a real 2D canvas — from = red,
// to = blue — asserting the drawn pixels at key progress points.

const W = 100;
const H = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- napi canvas/ctx bridge for the DOM canvas API
type Any = any;

interface Pixel {
	r: number;
	g: number;
	b: number;
}

function solid({ color }: { color: string }): Any {
	const canvas = createCanvas(W, H);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, W, H);
	return canvas;
}

const FROM = solid({ color: "#ff0000" }); // red
const TO = solid({ color: "#0000ff" }); // blue

function renderAt({
	transition,
	progress,
}: {
	transition: TransitionDefinition;
	progress: number;
}): Any {
	const canvas = createCanvas(W, H);
	const ctx: Any = canvas.getContext("2d");
	transition.render({
		context: ctx,
		from: FROM,
		to: TO,
		width: W,
		height: H,
		progress,
		params: {},
	});
	return ctx;
}

function pixel({ ctx, x, y }: { ctx: Any; x: number; y: number }): Pixel {
	const data = ctx.getImageData(x, y, 1, 1).data;
	return { r: data[0], g: data[1], b: data[2] };
}

const isRed = ({ r, g, b }: Pixel): boolean => r > 180 && g < 80 && b < 80;
const isBlue = ({ r, g, b }: Pixel): boolean => b > 180 && r < 80 && g < 80;
const isWhite = ({ r, g, b }: Pixel): boolean => r > 180 && g > 180 && b > 180;

const CENTER = { x: 50, y: 30 };
const LEFT_QUARTER = { x: 25, y: 30 };
const RIGHT_QUARTER = { x: 75, y: 30 };

describe.each([
	["dip-white", dipWhiteTransition],
	["slide-left", slideLeftTransition],
	["push-left", pushLeftTransition],
	["zoom-in", zoomInTransition],
	["blur-through", blurThroughTransition],
] as const)("%s transition endpoints", (_name, transition) => {
	test("progress 0 shows the outgoing (from) clip", () => {
		const ctx = renderAt({ transition, progress: 0 });
		expect(isRed(pixel({ ctx, ...CENTER }))).toBe(true);
	});

	test("progress 1 shows the incoming (to) clip", () => {
		const ctx = renderAt({ transition, progress: 1 });
		expect(isBlue(pixel({ ctx, ...CENTER }))).toBe(true);
	});
});

describe("characteristic midpoints", () => {
	test("dip-white is fully white at the midpoint", () => {
		const ctx = renderAt({ transition: dipWhiteTransition, progress: 0.5 });
		expect(isWhite(pixel({ ctx, ...CENTER }))).toBe(true);
	});

	test("slide-left reveals the incoming clip from the right", () => {
		const ctx = renderAt({ transition: slideLeftTransition, progress: 0.5 });
		expect(isRed(pixel({ ctx, ...LEFT_QUARTER }))).toBe(true);
		expect(isBlue(pixel({ ctx, ...RIGHT_QUARTER }))).toBe(true);
	});

	test("push-left splits outgoing (left) and incoming (right)", () => {
		const ctx = renderAt({ transition: pushLeftTransition, progress: 0.5 });
		expect(isRed(pixel({ ctx, ...LEFT_QUARTER }))).toBe(true);
		expect(isBlue(pixel({ ctx, ...RIGHT_QUARTER }))).toBe(true);
	});
});
