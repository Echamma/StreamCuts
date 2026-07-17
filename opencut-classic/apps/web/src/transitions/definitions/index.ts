import { crossfadeTransition } from "./crossfade";
import { fadeBlackTransition } from "./fade-black";
import { wipeLeftTransition } from "./wipe-left";
import { wipeRightTransition } from "./wipe-right";
import { dipWhiteTransition } from "./dip-white";
import { slideLeftTransition } from "./slide-left";
import { pushLeftTransition } from "./push-left";
import { zoomInTransition } from "./zoom-in";
import { blurThroughTransition } from "./blur-through";

export const defaultTransitions = [
	crossfadeTransition,
	fadeBlackTransition,
	dipWhiteTransition,
	wipeLeftTransition,
	wipeRightTransition,
	slideLeftTransition,
	pushLeftTransition,
	zoomInTransition,
	blurThroughTransition,
];
