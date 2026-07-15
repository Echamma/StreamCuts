import type { TransitionDefinition } from "@/transitions/types";

const START_SCALE = 0.6;

export const zoomInTransition: TransitionDefinition = {
	type: "zoom-in",
	name: "Zoom In",
	description: "Zoom and fade the next clip up from the center.",
	keywords: ["zoom", "scale", "punch", "in"],
	defaultDurationSeconds: 0.5,
	render: ({ context, from, to, width, height, progress }) => {
		const clamped = Math.max(0, Math.min(1, progress));

		context.clearRect(0, 0, width, height);
		context.globalAlpha = 1;
		context.drawImage(from, 0, 0, width, height);

		// Incoming clip scales from START_SCALE up to full size while fading in.
		const scale = START_SCALE + (1 - START_SCALE) * clamped;
		const drawWidth = width * scale;
		const drawHeight = height * scale;
		context.globalAlpha = clamped;
		context.drawImage(
			to,
			(width - drawWidth) / 2,
			(height - drawHeight) / 2,
			drawWidth,
			drawHeight,
		);
		context.globalAlpha = 1;
	},
};
