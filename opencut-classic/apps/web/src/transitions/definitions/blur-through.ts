import type { TransitionDefinition } from "@/transitions/types";

const MAX_BLUR_PX = 16;

export const blurThroughTransition: TransitionDefinition = {
	type: "blur-through",
	name: "Blur Through",
	description: "Cross-fade through a soft focus peak between the two clips.",
	keywords: ["blur", "defocus", "dream", "through"],
	defaultDurationSeconds: 0.55,
	render: ({ context, from, to, width, height, progress }) => {
		const clamped = Math.max(0, Math.min(1, progress));
		// Blur amount peaks at the midpoint (sin curve) so each clip stays crisp
		// at its own endpoint; a linear crossfade blends the two.
		const blurPx = MAX_BLUR_PX * Math.sin(Math.PI * clamped);
		const blurFilter = blurPx > 0.01 ? `blur(${blurPx.toFixed(2)}px)` : "none";

		context.clearRect(0, 0, width, height);
		context.globalAlpha = 1 - clamped;
		context.filter = blurFilter;
		context.drawImage(from, 0, 0, width, height);
		context.globalAlpha = clamped;
		context.drawImage(to, 0, 0, width, height);
		context.filter = "none";
		context.globalAlpha = 1;
	},
};
