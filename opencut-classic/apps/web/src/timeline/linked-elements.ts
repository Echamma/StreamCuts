import type { PlannedElementMove } from "@/timeline/group-move/types";
import { getOrderedTimelineTracks } from "@/timeline/scene-tracks-view";
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline/types";
import { addMediaTime, subMediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * Linked A/V clips (EDIT-025). Elements that share a `linkId` (see
 * {@link "@/timeline/types".BaseTimelineElement.linkId}) form a link group and
 * move/delete together, mirroring DaVinci's linked video+audio behaviour.
 *
 * Everything here is a pure transform over the scene tracks — no editor state,
 * no side effects — so it unit-tests natively and stays trivially safe: when no
 * element carries a `linkId`, every function is an identity (returns its input
 * unchanged), so an editor with no links behaves exactly as before.
 */

interface IndexedElement {
	ref: ElementRef;
	element: TimelineElement;
}

interface ElementIndex {
	byId: Map<string, IndexedElement>;
	byLinkId: Map<string, IndexedElement[]>;
}

/** Index every element by id and, when linked, group it by `linkId`. */
function buildElementIndex(tracks: SceneTracks): ElementIndex {
	const byId = new Map<string, IndexedElement>();
	const byLinkId = new Map<string, IndexedElement[]>();
	for (const track of getOrderedTimelineTracks({ tracks })) {
		for (const element of track.elements) {
			const indexed: IndexedElement = {
				ref: { trackId: track.id, elementId: element.id },
				element,
			};
			byId.set(element.id, indexed);
			const { linkId } = element;
			if (linkId !== undefined) {
				const group = byLinkId.get(linkId) ?? [];
				group.push(indexed);
				byLinkId.set(linkId, group);
			}
		}
	}
	return { byId, byLinkId };
}

/**
 * Given a set of element refs, return the refs of their linked siblings that are
 * NOT already in the input (deduped by element id). Used to expand a delete or a
 * selection so a whole link group travels as a unit. Returns `[]` when nothing
 * in `refs` is linked.
 */
export function getLinkedRefs({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): ElementRef[] {
	const { byId, byLinkId } = buildElementIndex(tracks);
	const inputIds = new Set(refs.map((ref) => ref.elementId));
	const resultById = new Map<string, ElementRef>();
	for (const ref of refs) {
		const linkId = byId.get(ref.elementId)?.element.linkId;
		if (linkId === undefined) {
			continue;
		}
		for (const sibling of byLinkId.get(linkId) ?? []) {
			if (inputIds.has(sibling.element.id)) {
				continue;
			}
			resultById.set(sibling.element.id, sibling.ref);
		}
	}
	return [...resultById.values()];
}

/**
 * Given the refs a caller intends to act on, return those refs plus their linked
 * siblings (deduped). Convenience wrapper over {@link getLinkedRefs} for the
 * common "act on the whole group" case such as deletion.
 */
export function expandRefsWithLinked({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): ElementRef[] {
	const linked = getLinkedRefs({ tracks, refs });
	if (linked.length === 0) {
		return refs;
	}
	const seen = new Set(refs.map((ref) => ref.elementId));
	const result = [...refs];
	for (const ref of linked) {
		if (seen.has(ref.elementId)) {
			continue;
		}
		seen.add(ref.elementId);
		result.push(ref);
	}
	return result;
}

/**
 * Extend a planned move set so linked siblings shift by the same time delta as
 * their moving partner, staying on their own track. A sibling that is already
 * being moved explicitly (its id appears in `moves`) is left untouched — the
 * explicit move wins. Siblings are clamped to `>= 0` so propagation can never
 * produce a negative start time (the rare cost is a momentary loss of rigid
 * offset only at the timeline's left edge). Returns `moves` unchanged when no
 * moving element is linked.
 */
export function propagateLinkedMoves({
	tracks,
	moves,
}: {
	tracks: SceneTracks;
	moves: PlannedElementMove[];
}): PlannedElementMove[] {
	if (moves.length === 0) {
		return moves;
	}
	const { byId, byLinkId } = buildElementIndex(tracks);
	const movedIds = new Set(moves.map((move) => move.elementId));
	const generated: PlannedElementMove[] = [];
	const generatedIds = new Set<string>();
	for (const move of moves) {
		const anchor = byId.get(move.elementId);
		const linkId = anchor?.element.linkId;
		if (anchor === undefined || linkId === undefined) {
			continue;
		}
		const delta = subMediaTime({
			a: move.newStartTime,
			b: anchor.element.startTime,
		});
		if (delta === ZERO_MEDIA_TIME) {
			continue;
		}
		for (const sibling of byLinkId.get(linkId) ?? []) {
			const siblingId = sibling.element.id;
			if (movedIds.has(siblingId) || generatedIds.has(siblingId)) {
				continue;
			}
			// Both branches are already MediaTime, so clamping to >= 0 needs no
			// cast (and no `maxMediaTime` import that a partial test mock might lack).
			const shifted = addMediaTime({ a: sibling.element.startTime, b: delta });
			generated.push({
				sourceTrackId: sibling.ref.trackId,
				targetTrackId: sibling.ref.trackId,
				elementId: siblingId,
				newStartTime: shifted > ZERO_MEDIA_TIME ? shifted : ZERO_MEDIA_TIME,
			});
			generatedIds.add(siblingId);
		}
	}
	if (generated.length === 0) {
		return moves;
	}
	return [...moves, ...generated];
}

/**
 * Whether the given element ref is part of a link group. Used by the UI to
 * decide when to show "Unlink".
 */
export function isRefLinked({
	tracks,
	ref,
}: {
	tracks: SceneTracks;
	ref: ElementRef;
}): boolean {
	const { byId } = buildElementIndex(tracks);
	return byId.get(ref.elementId)?.element.linkId !== undefined;
}
