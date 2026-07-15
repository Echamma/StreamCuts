import type { AudioCapableElement } from "@/timeline/audio-state";

export const PAN_MIN = -1;
export const PAN_MAX = 1;
export const PAN_CENTER = 0;

/** Clamp a pan position to `[-1, 1]`; a non-finite value falls back to centre. */
export function clampPan({ value }: { value: number }): number {
	if (!Number.isFinite(value)) {
		return PAN_CENTER;
	}
	return Math.min(PAN_MAX, Math.max(PAN_MIN, value));
}

/**
 * Stereo balance of an audio-capable element, read from `params.pan`:
 * `-1` = hard left, `0` = centre, `+1` = hard right. Absent (old/typical
 * elements) means centre.
 */
export function getElementPan({
	element,
}: {
	element: AudioCapableElement;
}): number {
	const value = element.params.pan;
	return typeof value === "number" ? clampPan({ value }) : PAN_CENTER;
}

export interface ChannelGains {
	left: number;
	right: number;
}

/**
 * Per-channel gains for a pan position under a **unity-at-centre linear law**.
 *
 * Centre (`0`) yields `{ left: 1, right: 1 }` — an exact identity, so a clip
 * with no pan (every existing project) mixes byte-for-byte as before. Panning
 * towards one side linearly attenuates the opposite channel to `0` at the hard
 * edge, leaving the near channel at unity.
 *
 * This is deliberately *not* the Web Audio `StereoPannerNode` equal-power law,
 * which sits at `-3 dB` per channel at centre: that would both quieten every
 * existing project and diverge from what the export mixer applies. Playback and
 * export must share this law to stay consistent.
 */
export function panToChannelGains({ pan }: { pan: number }): ChannelGains {
	const clamped = clampPan({ value: pan });
	return {
		left: clamped <= 0 ? 1 : 1 - clamped,
		right: clamped >= 0 ? 1 : 1 + clamped,
	};
}
