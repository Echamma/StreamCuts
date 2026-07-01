import { crossfadeTransition } from "./crossfade";
import { fadeBlackTransition } from "./fade-black";
import { wipeLeftTransition } from "./wipe-left";
import { wipeRightTransition } from "./wipe-right";

export const defaultTransitions = [
	crossfadeTransition,
	fadeBlackTransition,
	wipeLeftTransition,
	wipeRightTransition,
];
