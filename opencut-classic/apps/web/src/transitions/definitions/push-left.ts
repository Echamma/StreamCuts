import type { TransitionDefinition } from "@/transitions/types";

export const pushLeftTransition: TransitionDefinition = {
	type: "push-left",
	name: "Push Left",
	description: "Push the current clip off-screen while the next clip pushes in.",
	keywords: ["push", "slide", "left"],
	defaultDurationSeconds: 0.45,
	render: ({ context, from, to, width, height, progress }) => {
		const clamped = Math.max(0, Math.min(1, progress));
		const shift = width * clamped;

		context.clearRect(0, 0, width, height);
		context.globalAlpha = 1;
		// Both clips travel left together: outgoing exits left, incoming follows
		// in from the right.
		context.drawImage(from, -shift, 0, width, height);
		context.drawImage(to, width - shift, 0, width, height);
	},
};
