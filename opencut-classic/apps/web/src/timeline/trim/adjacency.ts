import { addMediaTime, type MediaTime } from "@/wasm";

/** Minimal element shape for locating touching neighbours on a track. */
export interface AdjacencyElement {
	id: string;
	startTime: MediaTime;
	duration: MediaTime;
}

/**
 * The element whose out-point meets `elementId`'s in-point (they touch, no gap
 * and no overlap), or `null` when there is none. On a well-formed track at most
 * one element qualifies; if several do, the first in iteration order wins.
 */
export function findLeftAdjacentId({
	elements,
	elementId,
}: {
	elements: AdjacencyElement[];
	elementId: string;
}): string | null {
	const target = elements.find((element) => element.id === elementId);
	if (!target) {
		return null;
	}
	const neighbour = elements.find(
		(element) =>
			element.id !== elementId &&
			addMediaTime({ a: element.startTime, b: element.duration }) ===
				target.startTime,
	);
	return neighbour?.id ?? null;
}

/**
 * The element whose in-point meets `elementId`'s out-point, or `null` when there
 * is none. Mirror of {@link findLeftAdjacentId}.
 */
export function findRightAdjacentId({
	elements,
	elementId,
}: {
	elements: AdjacencyElement[];
	elementId: string;
}): string | null {
	const target = elements.find((element) => element.id === elementId);
	if (!target) {
		return null;
	}
	const targetEnd = addMediaTime({ a: target.startTime, b: target.duration });
	const neighbour = elements.find(
		(element) => element.id !== elementId && element.startTime === targetEnd,
	);
	return neighbour?.id ?? null;
}
