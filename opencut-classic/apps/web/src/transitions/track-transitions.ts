import type { ParamValues } from "@/params";
import type { ImageElement, TrackTransition, VideoElement } from "@/timeline";
import type { VideoTrack } from "@/timeline";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	minMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { transitionRegistry } from "./registry";

type VideoTrackElement = VideoElement | ImageElement;

function getSortedVideoTrackElements({
	track,
}: {
	track: VideoTrack;
}): VideoTrackElement[] {
	return [...track.elements].sort((left, right) => {
		if (left.startTime !== right.startTime) {
			return left.startTime - right.startTime;
		}
		return left.id.localeCompare(right.id);
	});
}

export const DEFAULT_TRANSITION_TYPE = "crossfade";

export function getVideoTrackTransitions({
	track,
}: {
	track: VideoTrack;
}): TrackTransition[] {
	return track.transitions ?? [];
}

export function getAdjacentVideoElements({
	track,
	elementId,
}: {
	track: VideoTrack;
	elementId: string;
}): { from: VideoTrackElement; to: VideoTrackElement } | null {
	const elements = getSortedVideoTrackElements({ track });
	const fromIndex = elements.findIndex((element) => element.id === elementId);
	if (fromIndex < 0 || fromIndex >= elements.length - 1) {
		return null;
	}

	const from = elements[fromIndex];
	const to = elements[fromIndex + 1];
	return from.startTime + from.duration === to.startTime ? { from, to } : null;
}

export function getMaxTransitionDuration({
	from,
	to,
}: {
	from: VideoTrackElement;
	to: VideoTrackElement;
}): MediaTime {
	return minMediaTime({
		a: from.duration,
		b: to.duration,
	});
}

export function getTransitionDefaultDuration({
	type,
	maxDuration,
}: {
	type: string;
	maxDuration: MediaTime;
}): MediaTime {
	const definition = transitionRegistry.get(type);
	const preferredDuration = definition?.defaultDurationSeconds ?? 0.5;
	return minMediaTime({
		a: mediaTimeFromSeconds({ seconds: preferredDuration }),
		b: maxDuration,
	});
}

export function upsertTrackTransition({
	track,
	from,
	to,
	type = DEFAULT_TRANSITION_TYPE,
	params,
	duration,
}: {
	track: VideoTrack;
	from: VideoTrackElement;
	to: VideoTrackElement;
	type?: string;
	params?: ParamValues;
	duration?: MediaTime;
}): TrackTransition[] {
	const maxDuration = getMaxTransitionDuration({ from, to });
	const nextDuration =
		duration && duration > ZERO_MEDIA_TIME
			? minMediaTime({ a: duration, b: maxDuration })
			: getTransitionDefaultDuration({ type, maxDuration });

	const current = getVideoTrackTransitions({ track });
	const existing = current.find(
		(transition) =>
			transition.fromElementId === from.id && transition.toElementId === to.id,
	);

	const nextTransition: TrackTransition = existing
		? {
				...existing,
				type,
				duration: nextDuration,
				enabled: true,
				params: params ?? existing.params,
			}
		: {
				id: crypto.randomUUID(),
				type,
				fromElementId: from.id,
				toElementId: to.id,
				duration: nextDuration,
				enabled: true,
				params,
			};

	return existing
		? current.map((transition) =>
				transition.id === existing.id ? nextTransition : transition,
			)
		: [...current, nextTransition];
}

export function removeTrackTransition({
	track,
	fromElementId,
	toElementId,
}: {
	track: VideoTrack;
	fromElementId: string;
	toElementId: string;
}): TrackTransition[] {
	return getVideoTrackTransitions({ track }).filter(
		(transition) =>
			!(
				transition.fromElementId === fromElementId &&
				transition.toElementId === toElementId
			),
	);
}

export function getTrackTransitionByElements({
	track,
	fromElementId,
	toElementId,
}: {
	track: VideoTrack;
	fromElementId: string;
	toElementId: string;
}): TrackTransition | null {
	return (
		getVideoTrackTransitions({ track }).find(
			(transition) =>
				transition.fromElementId === fromElementId &&
				transition.toElementId === toElementId &&
				transition.enabled !== false,
		) ?? null
	);
}

export function getRenderableTrackTransitions({
	track,
}: {
	track: VideoTrack;
}): Array<{
	transition: TrackTransition;
	from: VideoTrackElement;
	to: VideoTrackElement;
}> {
	const elements = getSortedVideoTrackElements({ track });
	const transitions: Array<{
		transition: TrackTransition;
		from: VideoTrackElement;
		to: VideoTrackElement;
	}> = [];

	for (let index = 0; index < elements.length - 1; index++) {
		const from = elements[index];
		const to = elements[index + 1];
		if (from.startTime + from.duration !== to.startTime) {
			continue;
		}

		const transition = getTrackTransitionByElements({
			track,
			fromElementId: from.id,
			toElementId: to.id,
		});
		if (!transition) {
			continue;
		}

		transitions.push({ transition, from, to });
	}

	return transitions;
}

export function getTransitionWindow({
	transition,
	cutTime,
}: {
	transition: TrackTransition;
	cutTime: MediaTime;
}): { startTime: MediaTime; endTime: MediaTime } {
	return {
		startTime: subMediaTime({ a: cutTime, b: transition.duration }),
		endTime: cutTime,
	};
}
