import type { TransitionDefinition } from "@/transitions/types";

export const fadeBlackTransition: TransitionDefinition = {
	type: "fade-black",
	name: "Fade To Black",
	description: "Dip through black between the two clips.",
	keywords: ["dip", "black", "fade"],
	defaultDurationSeconds: 0.6,
	render: ({ context, from, to, width, height, progress }) => {
		const clamped = Math.max(0, Math.min(1, progress));
		const firstHalf = clamped < 0.5;
		const strength = firstHalf ? clamped / 0.5 : (clamped - 0.5) / 0.5;

		context.clearRect(0, 0, width, height);
		context.globalAlpha = firstHalf ? 1 - strength : 0;
		context.drawImage(from, 0, 0, width, height);
		context.globalAlpha = 1;
		context.fillStyle = `rgba(0, 0, 0, ${firstHalf ? strength : 1 - strength})`;
		context.fillRect(0, 0, width, height);

		if (!firstHalf) {
			context.globalAlpha = strength;
			context.drawImage(to, 0, 0, width, height);
		}

		context.globalAlpha = 1;
	},
};
