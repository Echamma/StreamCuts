import type { TransitionDefinition } from "@/transitions/types";

export const slideLeftTransition: TransitionDefinition = {
	type: "slide-left",
	name: "Slide Left",
	description: "Slide the next clip in over the current one, right to left.",
	keywords: ["slide", "cover", "left"],
	defaultDurationSeconds: 0.45,
	render: ({ context, from, to, width, height, progress }) => {
		const clamped = Math.max(0, Math.min(1, progress));

		context.clearRect(0, 0, width, height);
		context.globalAlpha = 1;
		context.drawImage(from, 0, 0, width, height);
		// Incoming clip enters from the right edge and settles at x = 0.
		context.drawImage(to, width * (1 - clamped), 0, width, height);
	},
};
