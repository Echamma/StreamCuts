import { describe, expect, mock, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";

// Headless render smoke test: draws real caption frames with @napi-rs/canvas and
// asserts on pixels, so the per-word drawing path (placeWords + per-mode color /
// visibility) is exercised end-to-end — not just the timing math.
//
// The text layout chain pulls in @/timeline/defaults → @/wasm, whose wasm-bindgen
// init cannot run under `bun test`. We stub @/wasm (before the dynamic imports
// below) so the real drawing code loads without instantiating the wasm binary.
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 120000,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
	clampMediaTime: ({ time }: { time: number }) => time,
	roundFrameTime: ({ time }: { time: number }) => time,
	roundFrameTicks: ({ ticks }: { ticks: number }) => ticks,
	snapSeekMediaTime: ({ time }: { time: number }) => time,
	lastFrameMediaTime: ({ time }: { time: number }) => time,
	parseMediaTimecode: () => 0,
}));

const { measureTextLayout, drawMeasuredTextLayout } = await import(
	"@/text/primitives"
);
const { drawAnimatedCaptionLayout } = await import("@/text/caption-animation");
type CaptionAnimationMode =
	import("@/subtitles/animation/types").CaptionAnimationMode;

const W = 800;
const H = 180; // scaledFontSize = fontSize(20) * H / FONT_SIZE_SCALE_REFERENCE(90) = 40px
const CONTENT = "alpha beta gamma delta"; // four evenly-spaced words

// napi's 2D context is API-compatible with the DOM 2D context the layout code
// expects; `any` avoids threading the structural mismatch through the test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only ctx bridge
type RenderCtx = any;

interface Pixel {
	r: number;
	g: number;
	b: number;
	a: number;
}

function newCtx(): RenderCtx {
	return createCanvas(W, H).getContext("2d");
}

function layoutFor(ctx: RenderCtx) {
	return measureTextLayout({
		text: {
			content: CONTENT,
			fontSize: 20,
			fontFamily: "Arial",
			fontWeight: "bold",
			fontStyle: "normal",
			textAlign: "center",
		},
		canvasHeight: H,
		ctx,
	});
}

function renderAnimated({
	mode,
	progress,
}: {
	mode: CaptionAnimationMode;
	progress: number;
}): Uint8ClampedArray {
	const ctx = newCtx();
	const layout = layoutFor(ctx);
	ctx.save();
	ctx.translate(W / 2, H / 2);
	drawAnimatedCaptionLayout({
		ctx,
		layout,
		baseColor: "#ffffff",
		state: {
			config: {
				mode,
				highlightColor: "#facc15",
				highlightBackground: "transparent",
			},
			progress,
			durationSeconds: 4,
		},
	});
	ctx.restore();
	return ctx.getImageData(0, 0, W, H).data;
}

function renderStatic(): Uint8ClampedArray {
	const ctx = newCtx();
	const layout = layoutFor(ctx);
	ctx.save();
	ctx.translate(W / 2, H / 2);
	drawMeasuredTextLayout({ ctx, layout, textColor: "#ffffff" });
	ctx.restore();
	return ctx.getImageData(0, 0, W, H).data;
}

const isYellow = ({ r, g, b, a }: Pixel): boolean =>
	a > 20 && r > 180 && g > 140 && b < 130; // #facc15 ≈ (250, 204, 21)
const isInk = ({ a }: Pixel): boolean => a > 20;

function pixelAt({ data, i }: { data: Uint8ClampedArray; i: number }): Pixel {
	return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

function count({
	data,
	pred,
}: {
	data: Uint8ClampedArray;
	pred: (pixel: Pixel) => boolean;
}): number {
	let n = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (pred(pixelAt({ data, i }))) n++;
	}
	return n;
}

function yellowCentroidX({ data }: { data: Uint8ClampedArray }): number {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (isYellow(pixelAt({ data, i }))) {
			sum += (i / 4) % W;
			n++;
		}
	}
	return n > 0 ? sum / n : -1;
}

describe("caption animation — headless render", () => {
	test("glyphs actually paint (font renders)", () => {
		expect(count({ data: renderStatic(), pred: isInk })).toBeGreaterThan(200);
	});

	test("wordHighlight paints the highlight color; the static path does not", () => {
		expect(count({ data: renderStatic(), pred: isYellow })).toBe(0);
		expect(
			count({
				data: renderAnimated({ mode: "wordHighlight", progress: 0.6 }),
				pred: isYellow,
			}),
		).toBeGreaterThan(0);
	});

	test("the highlight tracks the playhead left → right", () => {
		const early = yellowCentroidX({
			data: renderAnimated({ mode: "wordHighlight", progress: 0.05 }),
		});
		const late = yellowCentroidX({
			data: renderAnimated({ mode: "wordHighlight", progress: 0.95 }),
		});
		expect(early).toBeGreaterThan(0);
		expect(late).toBeGreaterThan(0);
		expect(late).toBeGreaterThan(early);
	});

	test("typewriter reveals more text as progress advances", () => {
		const first = count({
			data: renderAnimated({ mode: "typewriter", progress: 0.1 }),
			pred: isInk,
		});
		const most = count({
			data: renderAnimated({ mode: "typewriter", progress: 0.95 }),
			pred: isInk,
		});
		expect(first).toBeGreaterThan(0);
		expect(most).toBeGreaterThan(first);
	});
});
