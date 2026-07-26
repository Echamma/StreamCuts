import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { getLinkedRefs, isRefLinked } from "@/timeline/linked-elements";
import { updateElementInSceneTracks } from "@/timeline/track-element-update";
import type { ElementRef, SceneTracks } from "@/timeline/types";
import { generateUUID } from "@/utils/id";

/**
 * Link the given elements into one group (EDIT-025): they receive a shared
 * fresh `linkId` and thereafter move/delete together. A no-op with fewer than
 * two distinct elements — a group of one is meaningless. Any prior link on the
 * selected elements is replaced by the new group.
 */
export class LinkElementsCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private readonly params: {
			elements: ElementRef[];
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const distinct = dedupeRefs(this.params.elements);
		if (distinct.length < 2) {
			return;
		}

		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const linkId = generateUUID();
		let tracks = this.savedState;
		for (const ref of distinct) {
			tracks = updateElementInSceneTracks({
				tracks,
				trackId: ref.trackId,
				elementId: ref.elementId,
				update: (element) => ({ ...element, linkId }),
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
 * Remove the given elements from their link group (EDIT-025). Unlinking is
 * whole-group: clearing one member's link clears every element that shared its
 * `linkId`, so no orphaned single-member links remain. A no-op when none of the
 * given elements is linked.
 */
export class UnlinkElementsCommand extends Command {
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

		// Expand to whole groups: the given refs plus their linked siblings.
		const toClear = [
			...this.params.elements,
			...getLinkedRefs({ tracks: currentTracks, refs: this.params.elements }),
		];
		const distinct = dedupeRefs(toClear).filter((ref) =>
			isRefLinked({ tracks: currentTracks, ref }),
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
					delete next.linkId;
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
