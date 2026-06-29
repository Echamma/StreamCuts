import type { ElementAnimations } from "@/animation/types";
import { resolveAnimationPathValueAtTime } from "@/animation";
import type { Reframe } from "./reframe";

export function resolveReframeAtTime({
	baseReframe,
	animations,
	localTime,
}: {
	baseReframe: Reframe;
	animations: ElementAnimations | undefined;
	localTime: number;
}): Reframe {
	const safeLocalTime = Math.max(0, localTime);
	return {
		x: resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "reframe.x",
			localTime: safeLocalTime,
			fallbackValue: baseReframe.x,
		}),
		y: resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "reframe.y",
			localTime: safeLocalTime,
			fallbackValue: baseReframe.y,
		}),
		scale: resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "reframe.scale",
			localTime: safeLocalTime,
			fallbackValue: baseReframe.scale,
		}),
	};
}
