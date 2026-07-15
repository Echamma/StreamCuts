import type { TextCanvasContext } from "@/text/layout";
import { setCanvasLetterSpacing } from "@/text/layout";
import type { MeasuredTextLayout } from "@/text/primitives";
import type { CaptionAnimationConfig } from "@/subtitles/animation/types";
import {
	computeActiveWord,
	resolveWordWindows,
} from "@/subtitles/animation/word-window";

/** Per-word timing in element-local seconds. Structurally matches both
 * `CaptionWordTiming` (@/timeline) and `CaptionWord` (@/subtitles/animation) so
 * either can be passed without an import cycle. */
export interface CaptionWordTime {
	text: string;
	start: number;
	end: number;
}

export interface CaptionAnimationRenderState {
	config: CaptionAnimationConfig;
	/** Element-local playback progress in [0, 1]. */
	progress: number;
	/** Element duration in seconds — converts the config's second-based tuning
	 * (easeSeconds, peakHoldSeconds) into the same time space as progress. */
	durationSeconds: number;
	/** Real per-word timings (element-local seconds). When absent, or when the
	 * count doesn't match the laid-out words, even-split timing is used. */
	words?: CaptionWordTime[];
}

interface LineWord {
	text: string;
	/** Char index where the word starts within its line (for prefix measuring). */
	charStart: number;
}

interface PlacedWord {
	text: string;
	lineIndex: number;
	/** x of the word's left edge, in the text block's anchor space. */
	left: number;
	width: number;
	globalIndex: number;
}

const PILL_PADDING_RATIO = 0.18;
const PILL_HEIGHT_RATIO = 1.15;
const PILL_CORNER_RATIO = 0.28;

function splitLineWords({ line }: { line: string }): LineWord[] {
	const words: LineWord[] = [];
	let cursor = 0;
	for (const part of line.split(" ")) {
		if (part.length > 0) {
			words.push({ text: part, charStart: cursor });
		}
		cursor += part.length + 1;
	}
	return words;
}

function lineStartX({
	textAlign,
	lineWidth,
}: {
	textAlign: MeasuredTextLayout["textAlign"];
	lineWidth: number;
}): number {
	if (textAlign === "center") return -lineWidth / 2;
	if (textAlign === "right") return -lineWidth;
	return 0;
}

/** Lay out every display word across all lines with an absolute left/width in
 * the block's anchor space, so each can be individually recolored or scaled. */
function placeWords({
	ctx,
	layout,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
}): PlacedWord[] {
	const placed: PlacedWord[] = [];
	let globalIndex = 0;

	for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
		const line = layout.lines[lineIndex];
		const lineWidth = layout.lineMetrics[lineIndex]?.width ?? 0;
		const startX = lineStartX({ textAlign: layout.textAlign, lineWidth });

		for (const word of splitLineWords({ line })) {
			const prefixWidth = ctx.measureText(line.slice(0, word.charStart)).width;
			const width = ctx.measureText(word.text).width;
			placed.push({
				text: word.text,
				lineIndex,
				left: startX + prefixWidth,
				width,
				globalIndex: globalIndex++,
			});
		}
	}

	return placed;
}

function clamp01({ value }: { value: number }): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/** Rise → hold → fall envelope in [0, 1] for the active word's peak effect.
 * `bounce` overshoots slightly on the way up for a springier feel. */
function peakEnvelope({
	elapsed,
	easeSeconds,
	holdSeconds,
	bounce,
}: {
	elapsed: number;
	easeSeconds: number;
	holdSeconds: number;
	bounce: boolean;
}): number {
	const ease = Math.max(easeSeconds, 1e-3);
	if (elapsed < 0) return 0;
	if (elapsed < ease) {
		const t = clamp01({ value: elapsed / ease });
		const eased = 1 - (1 - t) * (1 - t);
		return bounce ? eased * (1 + 0.25 * (1 - t)) : eased;
	}
	if (elapsed < ease + holdSeconds) return 1;
	const t = clamp01({ value: (elapsed - ease - holdSeconds) / ease });
	return 1 - t * t;
}

/** Draw the animated caption word-by-word. The block background pill (if any)
 * is expected to have been drawn already by the caller; this paints only the
 * glyphs, applying per-word color/scale/visibility from the animation config. */
export function drawAnimatedCaptionLayout({
	ctx,
	layout,
	baseColor,
	state,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	baseColor: string;
	state: CaptionAnimationRenderState;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textBaseline = textBaseline;
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	const placed = placeWords({ ctx, layout });
	if (placed.length === 0) return;

	const { config } = state;
	const windows = resolveWordWindows({
		wordCount: placed.length,
		durationSeconds: state.durationSeconds,
		words: state.words,
	});
	const currentTime = state.progress * state.durationSeconds;
	const { lastStartedIndex, currentIndex } = computeActiveWord({
		windows,
		currentTime,
	});

	const highlightColor = config.highlightColor ?? baseColor;
	const highlightBackground = config.highlightBackground;
	const peakScale = config.peakScale ?? 1;
	const easeSeconds = config.easeSeconds ?? 0.08;
	const holdSeconds = config.peakHoldSeconds ?? 0.08;

	for (const word of placed) {
		const lineY =
			word.lineIndex * layout.lineHeightPx - layout.block.visualCenterOffset;
		const centerX = word.left + word.width / 2;

		let color = baseColor;
		let scale = 1;
		let visible = true;

		switch (config.mode) {
			case "wordHighlight": {
				if (word.globalIndex === currentIndex) {
					color = highlightColor;
					if (
						highlightBackground &&
						highlightBackground !== "transparent"
					) {
						drawWordPill({
							ctx,
							centerX,
							lineY,
							wordWidth: word.width,
							scaledFontSize: layout.scaledFontSize,
							color: highlightBackground,
						});
					}
				}
				break;
			}
			case "karaokeLine": {
				if (word.globalIndex <= currentIndex) color = highlightColor;
				break;
			}
			case "typewriter": {
				visible = word.globalIndex <= lastStartedIndex;
				break;
			}
			case "pop":
			case "bounce": {
				if (word.globalIndex === currentIndex && currentIndex >= 0) {
					const elapsed = currentTime - windows[currentIndex].start;
					const env = peakEnvelope({
						elapsed,
						easeSeconds,
						holdSeconds,
						bounce: config.mode === "bounce",
					});
					scale = 1 + (peakScale - 1) * env;
				}
				break;
			}
			case "none":
				break;
		}

		if (!visible) continue;

		ctx.fillStyle = color;
		if (scale === 1) {
			ctx.textAlign = "left";
			ctx.fillText(word.text, word.left, lineY);
		} else {
			ctx.save();
			ctx.translate(centerX, lineY);
			ctx.scale(scale, scale);
			ctx.textAlign = "center";
			ctx.fillText(word.text, 0, 0);
			ctx.restore();
		}
	}
}

function drawWordPill({
	ctx,
	centerX,
	lineY,
	wordWidth,
	scaledFontSize,
	color,
}: {
	ctx: TextCanvasContext;
	centerX: number;
	lineY: number;
	wordWidth: number;
	scaledFontSize: number;
	color: string;
}): void {
	const padX = scaledFontSize * PILL_PADDING_RATIO;
	const height = scaledFontSize * PILL_HEIGHT_RATIO;
	const width = wordWidth + padX * 2;
	const left = centerX - width / 2;
	const top = lineY - height / 2;
	const radius = height * PILL_CORNER_RATIO;

	const prevFill = ctx.fillStyle;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.roundRect(left, top, width, height, radius);
	ctx.fill();
	ctx.fillStyle = prevFill;
}
