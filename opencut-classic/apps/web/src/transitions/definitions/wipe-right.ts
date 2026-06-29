import type { TransitionDefinition } from "@/transitions/types";

export const wipeRightTransition: TransitionDefinition = {
	type: "wipe-right",
	name: "Wipe Right",
	description: "Reveal the next clip from left to right.",
	keywords: ["wipe", "reveal", "right"],
	defaultDurationSeconds: 0.45,
	render: ({ context, from, to, width, height, progress }) => {
		const clamped = Math.max(0, Math.min(1, progress));
		const revealWidth = width * clamped;

		context.clearRect(0, 0, width, height);
		context.drawImage(from, 0, 0, width, height);
		if (revealWidth <= 0) {
			return;
		}

		context.save();
		context.beginPath();
		context.rect(0, 0, revealWidth, height);
		context.clip();
		context.drawImage(to, 0, 0, width, height);
		context.restore();
	},
};
