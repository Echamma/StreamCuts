import type { TransitionDefinition } from "@/transitions/types";

export const wipeLeftTransition: TransitionDefinition = {
	type: "wipe-left",
	name: "Wipe Left",
	description: "Reveal the next clip from right to left.",
	keywords: ["wipe", "reveal", "left"],
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
		context.rect(width - revealWidth, 0, revealWidth, height);
		context.clip();
		context.drawImage(to, 0, 0, width, height);
		context.restore();
	},
};
