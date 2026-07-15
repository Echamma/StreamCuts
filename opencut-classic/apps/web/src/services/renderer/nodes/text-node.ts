import { BaseNode } from "./base-node";
import type { TextElement } from "@/timeline";
import type { EffectPass } from "@/effects/types";
import type { BlendMode, Transform } from "@/rendering";
import { drawMeasuredTextLayout, drawTextBackgroundLayer } from "@/text/primitives";
import {
	drawAnimatedCaptionLayout,
	type CaptionAnimationRenderState,
} from "@/text/caption-animation";
import type { MeasuredTextElement } from "@/text/measure-element";

export type TextNodeParams = TextElement & {
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	canvasCenter: { x: number; y: number };
	canvasHeight: number;
	textBaseline?: CanvasTextBaseline;
};

export interface ResolvedTextNodeState {
	transform: Transform;
	opacity: number;
	textColor: string;
	backgroundColor: string;
	effectPasses: EffectPass[][];
	measuredText: MeasuredTextElement;
	/** Present only when this text element is an animated caption (EDIT-012).
	 * When set, the node draws its words individually instead of as a block. */
	captionAnimation?: CaptionAnimationRenderState;
}

export class TextNode extends BaseNode<TextNodeParams, ResolvedTextNodeState> {}

export function renderTextToContext({
	node,
	ctx,
}: {
	node: TextNode;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): void {
	const resolved = node.resolved;
	if (!resolved) {
		return;
	}

	const x = resolved.transform.position.x + node.params.canvasCenter.x;
	const y = resolved.transform.position.y + node.params.canvasCenter.y;
	const baseline = node.params.textBaseline ?? "middle";

	ctx.save();
	ctx.translate(x, y);
	ctx.scale(resolved.transform.scaleX, resolved.transform.scaleY);
	if (resolved.transform.rotate) {
		ctx.rotate((resolved.transform.rotate * Math.PI) / 180);
	}

	if (
		resolved.captionAnimation &&
		resolved.captionAnimation.config.mode !== "none"
	) {
		// Draw the block background once, then paint words individually so the
		// active word can be recolored/scaled without disturbing layout.
		drawTextBackgroundLayer({
			ctx,
			layout: resolved.measuredText,
			background: resolved.measuredText.resolvedBackground,
			backgroundColor: resolved.backgroundColor,
		});
		drawAnimatedCaptionLayout({
			ctx,
			layout: resolved.measuredText,
			baseColor: resolved.textColor,
			state: resolved.captionAnimation,
			textBaseline: baseline,
		});
	} else {
		drawMeasuredTextLayout({
			ctx,
			layout: resolved.measuredText,
			textColor: resolved.textColor,
			background: resolved.measuredText.resolvedBackground,
			backgroundColor: resolved.backgroundColor,
			textBaseline: baseline,
		});
	}

	ctx.restore();
}
