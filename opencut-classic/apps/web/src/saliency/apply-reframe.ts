import type { ElementAnimations, ScalarChannel } from "@/animation/types";
import type { ReframeChannels } from "./runner";

/**
 * Apply the saliency analyzer's reframe output onto an element's animation map
 * (EDIT-016). The analyzer returns `reframe.x` / `reframe.y` scalar channels in
 * normalized [0,1] centroid space — the exact axes the compositor pans on — so
 * this is a straight overwrite of those two channels, leaving every other
 * animated property (opacity, transform, scale, …) untouched.
 *
 * `reframe.scale` is intentionally NOT written: the analyzer only tracks the
 * salient point, and identity scale (1) keeps the compositor's aspect-fill crop
 * centered on the moving point. Zoom-to-subject is a follow-up.
 */

/** Clamp every key value of a scalar channel into [0,1] (defensive: the crate
 * contract is normalized, but a bad frame shouldn't push the crop off-canvas). */
function clampChannel({ channel }: { channel: ScalarChannel }): ScalarChannel {
	return {
		...channel,
		keys: channel.keys.map((key) => ({
			...key,
			value: Math.max(0, Math.min(1, key.value)),
		})),
	};
}

export function mergeReframeAnimations({
	animations,
	channels,
}: {
	animations: ElementAnimations | undefined;
	channels: ReframeChannels;
}): ElementAnimations {
	return {
		...animations,
		"reframe.x": clampChannel({ channel: channels["reframe.x"] }),
		"reframe.y": clampChannel({ channel: channels["reframe.y"] }),
	};
}

/** Count of keyframes produced (used for the completion toast). */
export function reframeKeyCount({
	channels,
}: {
	channels: ReframeChannels;
}): number {
	return channels["reframe.x"].keys.length;
}
