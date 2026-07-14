import type { TransitionDefinition } from "@/transitions/types";

export const dipWhiteTransition: TransitionDefinition = {
	type: "dip-white",
	name: "Dip To White",
	description: "Flash through white between the two clips.",
	keywords: ["dip", "white", "flash", "fade"],
	defaultDurationSeconds: 0.6,
	render: ({ context, from, to, width, height, progress }) => {
		const clamped = Math.max(0, Math.min(1, progress));
		const firstHalf = clamped < 0.5;
		const whiteAlpha = firstHalf ? clamped / 0.5 : (1 - clamped) / 0.5;

		context.clearRect(0, 0, width, height);
		context.globalAlpha = 1;
		context.drawImage(firstHalf ? from : to, 0, 0, width, height);
		context.globalAlpha = Math.max(0, Math.min(1, whiteAlpha));
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
		context.globalAlpha = 1;
	},
};
