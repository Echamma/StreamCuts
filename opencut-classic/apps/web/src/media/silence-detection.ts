import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import {
	getAssetSourceStartTime,
	getWaveformSourceKeyForAsset,
} from "@/media/asset-source";
import { collectAudibleCandidates } from "@/media/audio";
import { waveformCache } from "@/services/waveform-cache/service";
import { getSourceTimeAtClipTime } from "@/retime";
import { isRetimableElement, hasMediaId } from "@/timeline";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import { calculateTotalDuration } from "@/timeline";
import type { MediaTime } from "@/wasm";

export interface SilentTimeRange {
	start: MediaTime;
	end: MediaTime;
}

// 50 ms grid — fine enough for accurate detection, coarse enough to be fast
const GRID_RESOLUTION_SECONDS = 0.05;

export async function detectSilentRanges({
	tracks,
	mediaAssets,
	threshold = 0.03,
	minDurationSeconds = 0.5,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	threshold?: number;
	minDurationSeconds?: number;
}): Promise<SilentTimeRange[]> {
	const totalDurationTicks = calculateTotalDuration({ tracks });
	const totalDurationSeconds = totalDurationTicks / TICKS_PER_SECOND;

	if (totalDurationSeconds <= 0) return [];

	const candidates = collectAudibleCandidates({ tracks, mediaAssets });
	if (candidates.length === 0) return [];

	// Load all waveforms concurrently
	const waveformMap = new Map<
		string,
		Awaited<ReturnType<typeof waveformCache.getSourceSummary>> | null
	>();

	await Promise.all(
		candidates.map(async ({ element, mediaAsset }) => {
			if (!hasMediaId(element) || !mediaAsset) return;
			const sourceKey = getWaveformSourceKeyForAsset({ asset: mediaAsset });
			if (waveformMap.has(sourceKey)) return;
			try {
				const summary = await waveformCache.getSourceSummary({
					sourceKey,
					sourceFile: mediaAsset.file,
					audioUrl: mediaAsset.url,
				});
				waveformMap.set(sourceKey, summary);
			} catch {
				waveformMap.set(sourceKey, null);
			}
		}),
	);

	// Build a grid: for each slot, track peak amplitude and whether any
	// audio-capable element is playing.
	// -1  = no element present at this slot (skip during analysis)
	const gridCount = Math.ceil(totalDurationSeconds / GRID_RESOLUTION_SECONDS);
	const amplitudes = new Float32Array(gridCount).fill(-1);
	// 1 = a candidate without a resolved waveform is playing here → treat as non-silent
	const unresolvable = new Uint8Array(gridCount).fill(0);

	for (const { element, mediaAsset } of candidates) {
		const eStartSecs = element.startTime / TICKS_PER_SECOND;
		const eEndSecs = (element.startTime + element.duration) / TICKS_PER_SECOND;
		const trimStartSecs =
			((mediaAsset ? getAssetSourceStartTime({ asset: mediaAsset }) : 0) +
				element.trimStart) /
			TICKS_PER_SECOND;
		const retime = isRetimableElement(element) ? element.retime : undefined;

		const startSlot = Math.max(0, Math.floor(eStartSecs / GRID_RESOLUTION_SECONDS));
		const endSlot = Math.min(gridCount, Math.ceil(eEndSecs / GRID_RESOLUTION_SECONDS));

		const sourceKey =
			hasMediaId(element) && mediaAsset
				? getWaveformSourceKeyForAsset({ asset: mediaAsset })
				: null;
		const summary = sourceKey ? waveformMap.get(sourceKey) : undefined;

		for (let slot = startSlot; slot < endSlot; slot++) {
			// Mark as having content
			if (amplitudes[slot] < 0) amplitudes[slot] = 0;

			if (summary === undefined || summary === null) {
				// Can't resolve waveform — assume non-silent to avoid false cuts
				unresolvable[slot] = 1;
				continue;
			}

			const slotTimeSecs = slot * GRID_RESOLUTION_SECONDS;
			const clipTimeSecs = Math.max(0, slotTimeSecs - eStartSecs);
			const sourceTimeSecs =
				trimStartSecs +
				getSourceTimeAtClipTime({ clipTime: clipTimeSecs, retime });

			const sampleIndex = Math.floor(sourceTimeSecs * summary.sampleRate);
			const bucketIndex = Math.floor(sampleIndex / summary.bucketSize);

			if (bucketIndex >= 0 && bucketIndex < summary.amplitudes.length) {
				const amp = summary.amplitudes[bucketIndex] ?? 0;
				if (amp > amplitudes[slot]) amplitudes[slot] = amp;
			}
		}
	}

	// Identify silent slots
	const minSlots = Math.ceil(minDurationSeconds / GRID_RESOLUTION_SECONDS);
	const silentRanges: SilentTimeRange[] = [];
	let silenceStart: number | null = null;

	for (let slot = 0; slot <= gridCount; slot++) {
		const amp = amplitudes[slot] ?? -1;
		const isSilent =
			amp >= 0 && // element is playing here
			!unresolvable[slot] && // we can actually analyze it
			amp < threshold;

		if (isSilent) {
			if (silenceStart === null) silenceStart = slot;
		} else {
			if (silenceStart !== null) {
				const len = slot - silenceStart;
				if (len >= minSlots) {
					silentRanges.push({
						start: roundMediaTime({
							time: silenceStart * GRID_RESOLUTION_SECONDS * TICKS_PER_SECOND,
						}),
						end: roundMediaTime({
							time: slot * GRID_RESOLUTION_SECONDS * TICKS_PER_SECOND,
						}),
					});
				}
				silenceStart = null;
			}
		}
	}

	return silentRanges;
}
