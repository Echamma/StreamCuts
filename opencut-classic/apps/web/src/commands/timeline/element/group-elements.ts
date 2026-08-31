import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { getGroupedRefs, isRefGrouped } from "@/timeline/element-groups";
import { updateElementInSceneTracks } from "@/timeline/track-element-update";
import type { ElementRef, SceneTracks } from "@/timeline/types";
import { generateUUID } from "@/utils/id";

/**
 * Group the given elements (EDIT-006): they receive a shared fresh `groupId`
 * and thereafter select, move and delete together. A no-op with fewer than two
 * distinct elements — a group of one is meaningless. Any prior group on the
 * selected elements is replaced by the new one.
 *
 * The selection is first expanded through existing group/link relations, so
 * grouping a clip whose audio was separated pulls that audio in rather than
 * splitting the pair across two groups.
 */
export class GroupElementsCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private readonly params: {
			elements: ElementRef[];
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const currentTracks = editor.scenes.getActiveScene().tracks;

		const distinct = dedupeRefs([
			...this.params.elements,
			...getGroupedRefs({ tracks: currentTracks, refs: this.params.elements }),
		]);
		if (distinct.length < 2) {
			return;
		}

		this.savedState = currentTracks;
		const groupId = generateUUID();
		let tracks = currentTracks;
		for (const ref of distinct) {
			tracks = updateElementInSceneTracks({
				tracks,
				trackId: ref.trackId,
				elementId: ref.elementId,
				update: (element) => ({ ...element, groupId }),
			});
		}
		editor.timeline.updateTracks(tracks);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}

/**
 * Remove the given elements from their group (EDIT-006). Ungrouping is
 * whole-group: clearing one member clears every element that shared its
 * `groupId`, so no orphaned single-member groups remain. A no-op when none of
 * the given elements is grouped.
 *
 * Link relationships are deliberately left intact — ungrouping a clip should
 * not also tear apart its A/V pair, which has its own Unlink action.
 */
export class UngroupElementsCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private readonly params: {
			elements: ElementRef[];
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const currentTracks = editor.scenes.getActiveScene().tracks;

		const toClear = [
			...this.params.elements,
			...getGroupedRefs({ tracks: currentTracks, refs: this.params.elements }),
		];
		const distinct = dedupeRefs(toClear).filter((ref) =>
			isRefGrouped({ tracks: currentTracks, ref }),
		);
		if (distinct.length === 0) {
			return;
		}

		this.savedState = currentTracks;
		let tracks = currentTracks;
		for (const ref of distinct) {
			tracks = updateElementInSceneTracks({
				tracks,
				trackId: ref.trackId,
				elementId: ref.elementId,
				update: (element) => {
					const next = { ...element };
					delete next.groupId;
					return next;
				},
			});
		}
		editor.timeline.updateTracks(tracks);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}

function dedupeRefs(refs: ElementRef[]): ElementRef[] {
	const seen = new Set<string>();
	const result: ElementRef[] = [];
	for (const ref of refs) {
		if (seen.has(ref.elementId)) {
			continue;
		}
		seen.add(ref.elementId);
		result.push(ref);
	}
	return result;
}
