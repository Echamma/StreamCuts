import { getOrderedTimelineTracks } from "@/timeline/scene-tracks-view";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
} from "@/timeline/types";
import { addMediaTime, subMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * Compound clips (EDIT-007): fold a selection of timeline elements into one
 * nested timeline that behaves like a single clip, and unfold it again.
 *
 * The nested timeline is itself a {@link SceneTracks}, so the renderer can
 * recurse into a compound exactly as it walks the top level, and a compound can
 * contain a compound. Nested elements are stored **relative to the compound's
 * own start**, which is what makes the compound movable: shifting it moves
 * everything inside without touching the children.
 *
 * Everything here is pure arithmetic over the tracks — no editor state, no ids
 * generated, no side effects — so it unit-tests directly and round-trips
 * exactly: decomposing a compound restores the elements the fold consumed.
 */

/** The nested timeline held by a compound clip. */
export interface CompoundContent {
	/** Child elements, with `startTime` relative to the compound's start. */
	tracks: SceneTracks;
	/** Span from the earliest child start to the latest child end. */
	duration: MediaTime;
}

/** A compound folded out of a selection, plus the refs it consumed. */
export interface CompoundPlan {
	/** Where the compound sits on the parent timeline. */
	startTime: MediaTime;
	content: CompoundContent;
	/** The elements that were folded in, to be removed from the parent. */
	sourceRefs: ElementRef[];
}

/** End of an element on its own track's timeline. */
function elementEnd(element: TimelineElement): MediaTime {
	return addMediaTime({ a: element.startTime, b: element.duration });
}

/**
 * Fold the given refs into a compound.
 *
 * The compound starts at the earliest selected element and runs to the latest
 * selected end, so it occupies exactly the span the selection did. Children are
 * rebased to that start and keep their original track (empty tracks are
 * dropped), so relative layering, timing and gaps between them survive the fold
 * untouched.
 *
 * Returns `null` for a selection of fewer than two elements — a compound of one
 * clip adds nesting without adding meaning.
 */
export function planCompound({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): CompoundPlan | null {
	const selectedIds = new Set(refs.map((ref) => ref.elementId));
	const ordered = getOrderedTimelineTracks({ tracks });

	let earliest: MediaTime | null = null;
	let latest: MediaTime | null = null;
	let count = 0;
	for (const track of ordered) {
		for (const element of track.elements) {
			if (!selectedIds.has(element.id)) {
				continue;
			}
			count += 1;
			if (earliest === null || element.startTime < earliest) {
				earliest = element.startTime;
			}
			const end = elementEnd(element);
			if (latest === null || end > latest) {
				latest = end;
			}
		}
	}

	if (count < 2 || earliest === null || latest === null) {
		return null;
	}

	const startTime = earliest;
	const duration = subMediaTime({ a: latest, b: startTime });

	// Rebuild each source track carrying only the selected elements, rebased to
	// the compound's start; tracks that contributed nothing are dropped. Each
	// bucket is written out rather than indexed dynamically, so every element
	// keeps its concrete type instead of collapsing to a union.
	const isSelected = (element: TimelineElement) => selectedIds.has(element.id);

	const nested: SceneTracks = {
		video: tracks.video
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
		text: tracks.text
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
		graphic: tracks.graphic
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
		effect: tracks.effect
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
		audio: tracks.audio
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
	};

	// Which refs the fold consumed, in track order.
	const sourceRefs: ElementRef[] = [];
	for (const track of ordered) {
		for (const element of track.elements) {
			if (selectedIds.has(element.id)) {
				sourceRefs.push({ trackId: track.id, elementId: element.id });
			}
		}
	}

	return {
		startTime,
		content: { tracks: nested, duration },
		sourceRefs,
	};
}

/** An element restored from a compound, with the track it belongs on. */
export interface DecomposedElement {
	trackId: string;
	element: TimelineElement;
}

/**
 * Unfold a compound back onto the parent timeline at `startTime`, undoing
 * {@link planCompound}: every child's start is rebased from compound-relative
 * back to absolute. Children whose rebased start would fall before zero are
 * clamped, which can only happen if a caller places a compound at a negative
 * time.
 */
export function decomposeCompound({
	content,
	startTime,
}: {
	content: CompoundContent;
	startTime: MediaTime;
}): DecomposedElement[] {
	const restored: DecomposedElement[] = [];
	for (const track of getOrderedTimelineTracks({ tracks: content.tracks })) {
		for (const element of track.elements) {
			const absolute = addMediaTime({ a: element.startTime, b: startTime });
			restored.push({
				trackId: track.id,
				element: {
					...element,
					startTime: absolute > ZERO_MEDIA_TIME ? absolute : ZERO_MEDIA_TIME,
				},
			});
		}
	}
	return restored;
}

/**
 * Total span of a compound's children, recomputed from its content. Used after
 * editing inside a compound, where a child may now extend past the duration
 * recorded when it was folded.
 */
export function measureCompoundDuration({
	content,
}: {
	content: CompoundContent;
}): MediaTime {
	let latest: MediaTime = ZERO_MEDIA_TIME;
	for (const track of getOrderedTimelineTracks({ tracks: content.tracks })) {
		for (const element of track.elements) {
			const end = elementEnd(element);
			if (end > latest) {
				latest = end;
			}
		}
	}
	return latest;
}

/** A fresh empty nested timeline, for constructing a compound with no children. */
export function emptyCompoundTracks(): SceneTracks {
	return { video: [], text: [], graphic: [], effect: [], audio: [] };
}
