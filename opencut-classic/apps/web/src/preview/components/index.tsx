"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { PreviewRenderScheduler } from "@/services/renderer/preview-render-scheduler";
import { onRenderPerfFrameComplete } from "@/diagnostics/render-perf";
import { TICKS_PER_SECOND } from "@/wasm";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { buildScene } from "@/services/renderer/scene-builder";
import { PreviewOverlayLayer } from "./overlay-layer";
import { PreviewInteractionOverlay } from "./preview-interaction-overlay";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import type {
	PreviewOverlayControl,
	PreviewOverlayInstance,
} from "@/preview/overlays";
import { PreviewContextMenu } from "./context-menu";
import { PreviewToolbar } from "./toolbar";
import {
	PreviewViewportProvider,
	usePreviewViewportState,
} from "./preview-viewport";

function usePreviewSize() {
	const canvasSize = useEditor(
		(e) => e.project.getActive()?.settings.canvasSize,
	);

	return {
		width: canvasSize?.width,
		height: canvasSize?.height,
	};
}

function normalizeWheelDelta({
	delta,
	deltaMode,
	pageSize,
}: {
	delta: number;
	deltaMode: number;
	pageSize: number;
}): number {
	if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
		return delta * 16;
	}

	if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
		return delta * pageSize;
	}

	return delta;
}

export function PreviewPanel({
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const { toggleFullscreen } = useFullscreen({ containerRef });
	const handleContainerRef = useCallback((node: HTMLDivElement | null) => {
		containerRef.current = node;
		setContainer(node);
	}, []);

	return (
		<div
			ref={handleContainerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<PreviewCanvas
				container={container}
				onToggleFullscreen={toggleFullscreen}
				overlayControls={overlayControls}
				overlayInstances={overlayInstances}
				onOverlayVisibilityChange={onOverlayVisibilityChange}
			/>
			<RenderTreeController />
		</div>
	);
}

/**
 * Watches only the four managers that affect the render tree (timeline,
 * scenes, media, project) and rebuilds the scene graph whenever any of them
 * notify.  Rapid back-to-back changes within the same display frame are
 * coalesced into a single rebuild via requestAnimationFrame batching,
 * eliminating the expensive deep-compare that useDeepCompareEffect performed
 * on the full tracks and mediaAssets objects.
 *
 * Canvas size (width/height) is included as a dep so the closure always uses
 * current dimensions; the effect cleanup cancels any pending RAF before
 * re-registering, preventing a stale-size build from landing after the resize.
 */
function RenderTreeController() {
	const editor = useEditor();
	const { width, height } = usePreviewSize();

	useEffect(() => {
		let rafId: number | null = null;

		const rebuild = () => {
			const activeProject = editor.project.getActiveOrNull();
			if (!activeProject) return;

			const tracks =
				editor.timeline.getPreviewTracks() ??
				editor.scenes.getActiveScene().tracks;
			const mediaAssets = editor.media.getAssets();
			const duration = editor.timeline.getTotalDuration();

			const renderTree = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize: { width, height },
				background: activeProject.settings.background,
				isPreview: true,
			});
			editor.renderer.setRenderTree({ renderTree });
		};

		const scheduleRebuild = () => {
			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				rebuild();
			});
		};

		// Only the four managers that affect the scene graph.
		const unsubs = [
			editor.timeline.subscribe(scheduleRebuild),
			editor.scenes.subscribe(scheduleRebuild),
			editor.media.subscribe(scheduleRebuild),
			editor.project.subscribe(scheduleRebuild),
		];

		// Build immediately on mount / when canvas size changes.
		// Cleanup cancels any pending RAF first, so a stale-size build
		// scheduled by the project subscription never lands after a resize.
		rebuild();

		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
			unsubs.forEach((fn) => fn());
		};
	}, [editor, width, height]);

	return null;
}

function PreviewCanvas({
	container,
	onToggleFullscreen,
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	container: HTMLElement | null;
	onToggleFullscreen: () => void;
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const canvasMountRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const viewportSize = useContainerSize({ containerRef: viewportRef });
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const viewport = usePreviewViewportState({
		canvasHeight: nativeHeight,
		canvasWidth: nativeWidth,
		viewportHeight: viewportSize.height,
		viewportRef,
		viewportWidth: viewportSize.width,
	});
	const { canPan, panByScreenDelta, scaleZoom } = viewport;

	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth,
			height: nativeHeight,
			fps: activeProject.settings.fps,
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps]);

	// Mount the compositor's output canvas directly into the preview. wgpu
	// renders straight into this element, so there is no intermediate copy —
	// the container div owns positioning/styling, the canvas itself fills it.
	useEffect(() => {
		const mount = canvasMountRef.current;
		if (!mount) return;
		const outputCanvas = renderer.getOutputCanvas();
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		mount.appendChild(outputCanvas);
		return () => {
			if (outputCanvas.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
	}, [renderer]);

	// Event-driven preview scheduling — replaces the unconditional RAF loop.
	// Renders fire only when playback time or the render tree actually changes.
	useEffect(() => {
		let lastRenderedFrame = -1;
		let lastRenderedTree: RootNode | null = null;

		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);

		const scheduler = new PreviewRenderScheduler(async ({ time, reason }) => {
			const tree = editor.renderer.getRenderTree();
			if (!tree) return;
			const clampedTime = Math.min(time, editor.timeline.getLastFrameTime());
			const frame = Math.floor(clampedTime / ticksPerFrame);
			if (frame === lastRenderedFrame && tree === lastRenderedTree) return;
			lastRenderedFrame = frame;
			lastRenderedTree = tree;
			await renderer.render({ node: tree, time: clampedTime });
			onRenderPerfFrameComplete({ reason });
		});

		// Playback ticks (fires on every RAF during active playback).
		const unsubUpdate = editor.playback.onUpdate((time) => {
			scheduler.requestFrame({ time, reason: "preview-playback" });
		});

		// Seek / scrub events.
		const unsubSeek = editor.playback.onSeek((time) => {
			scheduler.requestFrame({
				time,
				reason: editor.playback.getIsScrubbing() ? "preview-scrub" : "preview-idle",
			});
		});

		// Render-tree changes (scene edits, asset loads, settings changes).
		const unsubRenderer = editor.renderer.subscribe(() => {
			// Reset so the next render isn't skipped even if frame number is same.
			lastRenderedTree = null;
			scheduler.requestFrame({
				time: editor.playback.getCurrentTime(),
				reason: "preview-edit",
			});
		});

		// Initial render on mount or when the renderer instance changes.
		scheduler.requestFrame({
			time: editor.playback.getCurrentTime(),
			reason: "preview-idle",
		});

		return () => {
			scheduler.dispose();
			unsubUpdate();
			unsubSeek();
			unsubRenderer();
		};
	}, [editor, renderer]);

	useEffect(() => {
		const container = viewportRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let pendingPanDeltaX = 0;
		let pendingPanDeltaY = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;
		let panRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (event: WheelEvent) => {
			const normalizedDeltaX = normalizeWheelDelta({
				delta: event.deltaX,
				deltaMode: event.deltaMode,
				pageSize: container.clientWidth,
			});
			const normalizedDeltaY = normalizeWheelDelta({
				delta: event.deltaY,
				deltaMode: event.deltaMode,
				pageSize: container.clientHeight,
			});
			const isZoomGesture = event.ctrlKey || event.metaKey;
			if (isZoomGesture) {
				event.preventDefault();
				pendingZoomDelta += normalizedDeltaY;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const cappedDelta =
							Math.sign(pendingZoomDelta) *
							Math.min(Math.abs(pendingZoomDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);

						scaleZoom({ factor: zoomFactor });
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}

				return;
			}

			if (!canPan) {
				return;
			}

			if (normalizedDeltaX === 0 && normalizedDeltaY === 0) {
				return;
			}

			event.preventDefault();
			pendingPanDeltaX += normalizedDeltaX;
			pendingPanDeltaY += normalizedDeltaY;

			if (panRafId === null) {
				panRafId = requestAnimationFrame(() => {
					panByScreenDelta({
						deltaX: pendingPanDeltaX,
						deltaY: pendingPanDeltaY,
					});
					pendingPanDeltaX = 0;
					pendingPanDeltaY = 0;
					panRafId = null;
				});
			}
		};

		container.addEventListener("wheel", onWheel, {
			capture: true,
			passive: false,
		});

		return () => {
			container.removeEventListener("wheel", onWheel, {
				capture: true,
			});
			if (zoomRafId !== null) {
				cancelAnimationFrame(zoomRafId);
			}
			if (panRafId !== null) {
				cancelAnimationFrame(panRafId);
			}
		};
	}, [canPan, panByScreenDelta, scaleZoom]);

	return (
		<PreviewViewportProvider value={viewport}>
			<div className="flex size-full min-h-0 min-w-0 flex-col">
				<div className="flex min-h-0 min-w-0 flex-1 p-2 pb-0">
					<ContextMenu>
						<ContextMenuTrigger asChild>
							<div
								ref={viewportRef}
								className="relative flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden"
							>
							<div
								ref={canvasMountRef}
								className="absolute block border"
								style={{
									left: viewport.sceneLeft,
									top: viewport.sceneTop,
									width: viewport.sceneWidth,
									height: viewport.sceneHeight,
									background:
										activeProject.settings.background.type === "blur"
											? "transparent"
											: activeProject?.settings.background.color,
								}}
							/>
								<PreviewOverlayLayer
									instances={overlayInstances}
									plane="under-interaction"
								/>
								<PreviewInteractionOverlay />
								<PreviewOverlayLayer
									instances={overlayInstances}
									plane="over-interaction"
								/>
							</div>
						</ContextMenuTrigger>
						<PreviewContextMenu
							onToggleFullscreen={onToggleFullscreen}
							container={container}
							overlayControls={overlayControls}
							onOverlayVisibilityChange={onOverlayVisibilityChange}
						/>
					</ContextMenu>
				</div>
				<PreviewToolbar onToggleFullscreen={onToggleFullscreen} />
			</div>
		</PreviewViewportProvider>
	);
}
