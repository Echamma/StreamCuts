import type { TransitionDefinition } from "@/transitions/types";

export const crossfadeTransition: TransitionDefinition = {
	type: "crossfade",
	name: "Crossfade",
	description: "Blend the outgoing clip into the incoming clip.",
	keywords: ["dissolve", "fade", "blend"],
	defaultDurationSeconds: 0.5,
	render: ({ context, from, to, width, height, progress }) => {
		context.clearRect(0, 0, width, height);
		context.globalAlpha = 1;
		context.drawImage(from, 0, 0, width, height);
		context.globalAlpha = Math.max(0, Math.min(1, progress));
		context.drawImage(to, 0, 0, width, height);
		context.globalAlpha = 1;
	},
};
