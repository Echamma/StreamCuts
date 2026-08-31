import type { PlannedElementMove } from "@/timeline/group-move/types";
import { getOrderedTimelineTracks } from "@/timeline/scene-tracks-view";
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline/types";
import { addMediaTime, subMediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * Clip groups (EDIT-006). Elements sharing a `groupId` (see
 * {@link "@/timeline/types".BaseTimelineElement.groupId}) are selected, moved
 * and deleted as one unit, mirroring DaVinci's clip grouping.
 *
 * Groups compose with linked A/V pairs (EDIT-025) rather than competing with
 * them: membership is the **transitive closure** over both relations, so
 * grouping a video clip whose audio was separated carries that audio too, and a
 * clip linked to a grouped clip joins the whole group. Callers therefore never
 * need to run link expansion and group expansion separately.
 *
 * Everything here is a pure transform over the scene tracks — no editor state,
 * no side effects — so it unit-tests natively. When no element carries a
 * `groupId` or `linkId`, every function is an identity on its input, so an
 * editor with no groups behaves exactly as before.
 */

interface IndexedElement {
	ref: ElementRef;
	element: TimelineElement;
}

interface RelationIndex {
	byId: Map<string, IndexedElement>;
	/** Elements keyed by each relation they belong to (`group:x` / `link:y`). */
	byRelation: Map<string, IndexedElement[]>;
}

/**
 * Relation keys an element belongs to, namespaced so a group id can never
 * collide with a link id.
 */
function relationKeys(element: TimelineElement): string[] {
	const keys: string[] = [];
	if (element.groupId !== undefined) {
		keys.push(`group:${element.groupId}`);
	}
	if (element.linkId !== undefined) {
		keys.push(`link:${element.linkId}`);
	}
	return keys;
}

function buildRelationIndex(tracks: SceneTracks): RelationIndex {
	const byId = new Map<string, IndexedElement>();
	const byRelation = new Map<string, IndexedElement[]>();
	for (const track of getOrderedTimelineTracks({ tracks })) {
		for (const element of track.elements) {
			const indexed: IndexedElement = {
				ref: { trackId: track.id, elementId: element.id },
				element,
			};
			byId.set(element.id, indexed);
			for (const key of relationKeys(element)) {
				const members = byRelation.get(key) ?? [];
				members.push(indexed);
				byRelation.set(key, members);
			}
		}
	}
	return { byId, byRelation };
}

/**
 * Every element reachable from `startIds` by walking group and link relations,
 * including the starting elements themselves. Breadth-first with a visited set,
 * so a cycle of relations terminates and each element is produced once.
 */
function collectRelatedIds({
	startIds,
	index,
}: {
	startIds: Iterable<string>;
	index: RelationIndex;
}): Map<string, IndexedElement> {
	const found = new Map<string, IndexedElement>();
	const queue: string[] = [];

	for (const id of startIds) {
		const indexed = index.byId.get(id);
		if (indexed !== undefined && !found.has(id)) {
			found.set(id, indexed);
			queue.push(id);
		}
	}

	while (queue.length > 0) {
		// Shift is fine here: a relation closure spans a handful of clips, not a
		// timeline-sized queue.
		const id = queue.shift();
		const indexed = id === undefined ? undefined : found.get(id);
		if (indexed === undefined) {
			continue;
		}
		for (const key of relationKeys(indexed.element)) {
			for (const member of index.byRelation.get(key) ?? []) {
				const memberId = member.element.id;
				if (found.has(memberId)) {
					continue;
				}
				found.set(memberId, member);
				queue.push(memberId);
			}
		}
	}

	return found;
}

/**
 * Given a set of element refs, return the refs of their group/link relatives
 * that are NOT already in the input (deduped by element id). Used to expand a
 * delete or a selection so a whole group travels as a unit. Returns `[]` when
 * nothing in `refs` is grouped or linked.
 */
export function getGroupedRefs({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): ElementRef[] {
	const index = buildRelationIndex(tracks);
	const inputIds = new Set(refs.map((ref) => ref.elementId));
	const related = collectRelatedIds({ startIds: inputIds, index });

	const result: ElementRef[] = [];
	for (const [id, indexed] of related) {
		if (!inputIds.has(id)) {
			result.push(indexed.ref);
		}
	}
	return result;
}

/**
 * The refs a caller intends to act on plus their group/link relatives (deduped,
 * input order preserved first). Convenience wrapper over
 * {@link getGroupedRefs} for the common "act on the whole group" case.
 */
export function expandRefsWithGroups({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): ElementRef[] {
	const related = getGroupedRefs({ tracks, refs });
	if (related.length === 0) {
		return refs;
	}
	const seen = new Set(refs.map((ref) => ref.elementId));
	const result = [...refs];
	for (const ref of related) {
		if (seen.has(ref.elementId)) {
			continue;
		}
		seen.add(ref.elementId);
		result.push(ref);
	}
	return result;
}

/**
 * Extend a planned move set so every group/link relative shifts by the same
 * time delta as the element that moved, staying on its own track. A relative
 * that is already being moved explicitly is left untouched — the explicit move
 * wins. Starts are clamped to `>= 0`, so propagation can never produce a
 * negative start time. Returns `moves` unchanged when nothing moving is
 * grouped or linked.
 */
export function propagateGroupMoves({
	tracks,
	moves,
}: {
	tracks: SceneTracks;
	moves: PlannedElementMove[];
}): PlannedElementMove[] {
	if (moves.length === 0) {
		return moves;
	}
	const index = buildRelationIndex(tracks);
	const movedIds = new Set(moves.map((move) => move.elementId));
	const generated: PlannedElementMove[] = [];
	const generatedIds = new Set<string>();

	for (const move of moves) {
		const anchor = index.byId.get(move.elementId);
		if (anchor === undefined) {
			continue;
		}
		const delta = subMediaTime({
			a: move.newStartTime,
			b: anchor.element.startTime,
		});
		if (delta === ZERO_MEDIA_TIME) {
			continue;
		}
		const related = collectRelatedIds({ startIds: [move.elementId], index });
		for (const [relativeId, relative] of related) {
			if (
				relativeId === move.elementId ||
				movedIds.has(relativeId) ||
				generatedIds.has(relativeId)
			) {
				continue;
			}
			// Both operands are already MediaTime, so clamping to >= 0 needs no
			// cast (and no `maxMediaTime` import a partial test mock might lack).
			const shifted = addMediaTime({
				a: relative.element.startTime,
				b: delta,
			});
			generated.push({
				sourceTrackId: relative.ref.trackId,
				targetTrackId: relative.ref.trackId,
				elementId: relativeId,
				newStartTime: shifted > ZERO_MEDIA_TIME ? shifted : ZERO_MEDIA_TIME,
			});
			generatedIds.add(relativeId);
		}
	}

	if (generated.length === 0) {
		return moves;
	}
	return [...moves, ...generated];
}

/**
 * Whether the given ref belongs to a user group. Used by the UI to decide
 * between showing "Group" and "Ungroup" — deliberately ignores `linkId`, since
 * a merely linked clip is not grouped.
 */
export function isRefGrouped({
	tracks,
	ref,
}: {
	tracks: SceneTracks;
	ref: ElementRef;
}): boolean {
	const { byId } = buildRelationIndex(tracks);
	return byId.get(ref.elementId)?.element.groupId !== undefined;
}

/**
 * The group id shared by everything in `refs`, or `null` when the selection
 * spans several groups or includes an ungrouped element. Lets the UI offer
 * "Ungroup" only when it would act on exactly one group.
 */
export function getSharedGroupId({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): string | null {
	const { byId } = buildRelationIndex(tracks);
	let shared: string | null = null;
	for (const ref of refs) {
		const groupId = byId.get(ref.elementId)?.element.groupId;
		if (groupId === undefined) {
			return null;
		}
		if (shared === null) {
			shared = groupId;
		} else if (shared !== groupId) {
			return null;
		}
	}
	return shared;
}
