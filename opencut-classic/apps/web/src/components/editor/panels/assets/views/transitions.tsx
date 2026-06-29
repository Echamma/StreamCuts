"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import {
	getAdjacentVideoElements,
	getTrackTransitionByElements,
	transitionRegistry,
} from "@/transitions";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowRightDoubleIcon,
	Delete02Icon,
	Link02Icon,
} from "@hugeicons/core-free-icons";

export function TransitionsView() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();

	const selection = useMemo(() => {
		if (selectedElements.length !== 1) {
			return null;
		}

		const selected = editor.timeline.getElementsWithTracks({
			elements: selectedElements,
		})[0];
		if (!selected || selected.track.type !== "video") {
			return null;
		}

		const adjacent = getAdjacentVideoElements({
			track: selected.track,
			elementId: selected.element.id,
		});
		if (!adjacent) {
			return null;
		}

		return {
			track: selected.track,
			from: adjacent.from,
			to: adjacent.to,
			current: getTrackTransitionByElements({
				track: selected.track,
				fromElementId: adjacent.from.id,
				toElementId: adjacent.to.id,
			}),
		};
	}, [editor, selectedElements]);

	return (
		<PanelView title="Transitions" contentClassName="h-full">
			<div className="flex h-full flex-col gap-4">
				<div className="rounded-md border bg-accent/20 p-3">
					<p className="text-sm font-medium">Apply to the next cut</p>
					<p className="text-muted-foreground mt-1 text-xs">
						Select a clip on a video track, then apply a transition to the cut
						between that clip and the next one.
					</p>
					{selection ? (
						<p className="text-muted-foreground mt-2 text-xs">
							{selection.from.name} to {selection.to.name}
						</p>
					) : (
						<p className="text-muted-foreground mt-2 text-xs">
							Select a video clip that has another clip directly after it.
						</p>
					)}
				</div>

				<div className="grid gap-2">
					{transitionRegistry.list().map((definition) => {
						const isActive = selection?.current?.type === definition.type;
						return (
							<button
								key={definition.type}
								type="button"
								className="hover:bg-accent/60 flex items-start gap-3 rounded-md border p-3 text-left transition-colors"
								disabled={!selection}
								onClick={() => {
									if (!selection) return;
									editor.timeline.setTransitionToNextClip({
										trackId: selection.track.id,
										elementId: selection.from.id,
										type: definition.type,
									});
								}}
							>
								<div className="mt-0.5 rounded-sm border p-1.5">
									<HugeiconsIcon
										icon={ArrowRightDoubleIcon}
										className="size-4"
									/>
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium">
											{definition.name}
										</span>
										{isActive ? (
											<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
												Active
											</span>
										) : null}
									</div>
									<p className="text-muted-foreground mt-1 text-xs">
										{definition.description}
									</p>
								</div>
							</button>
						);
					})}
				</div>

				{selection?.current ? (
					<Button
						variant="outline"
						className="gap-2"
						onClick={() =>
							editor.timeline.removeTransitionToNextClip({
								trackId: selection.track.id,
								elementId: selection.from.id,
							})
						}
					>
						<HugeiconsIcon icon={Delete02Icon} className="size-4" />
						Remove transition
					</Button>
				) : null}

				<div className="mt-auto rounded-md border border-dashed p-3">
					<div className="flex items-center gap-2 text-sm font-medium">
						<HugeiconsIcon icon={Link02Icon} className="size-4" />
						Custom transitions
					</div>
					<p className="text-muted-foreground mt-1 text-xs">
						Add a new definition under `src/transitions/definitions/` and
						register it in `src/transitions/index.ts`. Each transition is a
						canvas render function that receives `from`, `to`, `progress`, and
						`params`.
					</p>
				</div>
			</div>
		</PanelView>
	);
}
