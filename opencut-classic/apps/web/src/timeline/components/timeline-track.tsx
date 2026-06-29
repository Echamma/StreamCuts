"use client";

import { useMemo } from "react";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { useTimelineScroll } from "./timeline-scroll-context";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/timeline";
import type { TimelineElement as TimelineElementType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import type { ElementDragView } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { useTextEditRequestStore } from "@/preview/text-edit-request-store";
import {
	getRenderableTrackTransitions,
	transitionRegistry,
} from "@/transitions";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	zoomLevel: number;
	dragView: ElementDragView;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
}

export function TimelineTrackContent({
	track,
	zoomLevel,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
}: TimelineTrackContentProps) {
	const editor = useEditor();
	const { isElementSelected } = useElementSelection();
	const { scrollLeft, viewportWidth } = useTimelineScroll();
	const requestTextEdit = useTextEditRequestStore((s) => s.requestTextEdit);

	// Cull clips that are fully outside the visible viewport + overscan.
	// During drag we skip culling so dragged clips don't vanish at the viewport edge.
	const OVERSCAN_PX = 300;
	const visibleElements = useMemo(() => {
		if (dragView.kind === "dragging") return track.elements;
		return track.elements.filter((el) => {
			const elLeft = timelineTimeToPixels({ time: el.startTime, zoomLevel });
			const elRight =
				elLeft + timelineTimeToPixels({ time: el.duration, zoomLevel });
			return (
				elRight > scrollLeft - OVERSCAN_PX &&
				elLeft < scrollLeft + viewportWidth + OVERSCAN_PX
			);
		});
	}, [dragView.kind, track.elements, zoomLevel, scrollLeft, viewportWidth]);

	return (
		<div className="relative size-full">
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={`Select ${track.name} track`}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					<>
						{track.type === "video"
							? getRenderableTrackTransitions({ track }).map(
									({ transition, to }) => {
										const definition = transitionRegistry.get(transition.type);
										if (!definition) {
											return null;
										}

										const left = timelineTimeToPixels({
											time: to.startTime,
											zoomLevel,
										});
										return (
											<button
												key={transition.id}
												type="button"
												className="bg-background/95 text-foreground absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full border px-2 py-0.5 text-[10px] shadow-sm"
												style={{ left }}
												onClick={(event) => {
													event.stopPropagation();
													editor.timeline.removeTransitionToNextClip({
														trackId: track.id,
														elementId: transition.fromElementId,
													});
												}}
												title={`${definition.name} transition. Click to remove.`}
											>
												{definition.name}
											</button>
										);
									},
								)
							: null}
						{visibleElements.map((element) => {
							const isSelected = isElementSelected({
								trackId: track.id,
								elementId: element.id,
							});

							return (
								<TimelineElement
									key={element.id}
									element={element}
									track={track}
									zoomLevel={zoomLevel}
									isSelected={isSelected}
									onResizeStart={({ event, element, side }) =>
										onResizeStart({ event, element, track, side })
									}
									onElementMouseDown={({ event, element }) =>
										onElementMouseDown({ event, element, track })
									}
									onElementClick={({ event, element }) =>
										onElementClick({ event, element, track })
									}
									onElementDoubleClick={({ element: el }) => {
										if (el.type === "text") {
											requestTextEdit({ trackId: track.id, elementId: el.id });
										}
									}}
									dragView={dragView}
									isDropTarget={element.id === targetElementId}
								/>
							);
						})}
					</>
				)}
			</div>
		</div>
	);
}
