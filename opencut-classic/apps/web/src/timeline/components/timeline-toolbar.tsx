import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import {
	TooltipProvider,
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
	SplitButton,
	SplitButtonLeft,
	SplitButtonRight,
	SplitButtonSeparator,
} from "@/components/ui/split-button";
import { Slider } from "@/components/ui/slider";
import { TIMELINE_ZOOM_BUTTON_FACTOR } from "./interaction";
import { TIMELINE_ZOOM_MAX } from "@/timeline/scale";
import { sliderToZoom, zoomToSlider } from "@/timeline/zoom-utils";
import { ScenesView } from "@/components/editor/scenes-view";
import { type TActionWithOptionalArgs, invokeAction } from "@/actions";
import { processMediaAssets } from "@/media/processing";
import { extractMediaClip } from "@/media/clip-extraction";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	canToggleSourceAudio,
	getSourceAudioActionLabel,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import { hasMediaId, isRetimableElement } from "@/timeline";
import { cn } from "@/utils/ui";
import { useTimelineStore } from "@/timeline/timeline-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	AudioWave01Icon,
	Bookmark02Icon,
	CloudUploadIcon,
	Delete02Icon,
	SnowIcon,
	ScissorIcon,
	MagnetIcon,
	SearchAddIcon,
	SearchMinusIcon,
	Copy01Icon,
	AlignLeftIcon,
	AlignRightIcon,
	Link02Icon,
	Layers01Icon,
	Chart03Icon,
	Unlink02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OcRippleIcon } from "@/components/icons";
import { GraphEditorPopover } from "./graph-editor/popover";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { useGraphEditorController } from "./graph-editor/use-controller";

export function TimelineToolbar({
	zoomLevel,
	minZoom,
	setZoomLevel,
}: {
	zoomLevel: number;
	minZoom: number;
	setZoomLevel: ({ zoom }: { zoom: number }) => void;
}) {
	const handleZoom = ({ direction }: { direction: "in" | "out" }) => {
		const newZoomLevel =
			direction === "in"
				? Math.min(TIMELINE_ZOOM_MAX, zoomLevel * TIMELINE_ZOOM_BUTTON_FACTOR)
				: Math.max(minZoom, zoomLevel / TIMELINE_ZOOM_BUTTON_FACTOR);
		setZoomLevel({ zoom: newZoomLevel });
	};

	return (
		<ScrollArea className="scrollbar-hidden">
			<div className="flex h-10 items-center justify-between border-b px-2 py-1">
				<ToolbarLeftSection />

				<SceneSelector />

				<ToolbarRightSection
					zoomLevel={zoomLevel}
					minZoom={minZoom}
					onZoomChange={(zoom) => setZoomLevel({ zoom })}
					onZoom={handleZoom}
				/>
			</div>
		</ScrollArea>
	);
}

function ToolbarLeftSection() {
	const editor = useEditor();
	const activeProject = useEditor((currentEditor) =>
		currentEditor.project.getActiveOrNull(),
	);
	const mediaAssets = useEditor((currentEditor) =>
		currentEditor.media.getAssets(),
	);
	const { selectedElements } = useElementSelection();
	const graphEditor = useGraphEditorController();
	const [isSavingSelectionClip, setIsSavingSelectionClip] = useState(false);
	const isCurrentlyBookmarked = useEditor((e) =>
		e.scenes.isBookmarked({ time: e.playback.getCurrentTime() }),
	);
	const selectedElement =
		selectedElements.length === 1
			? (editor.timeline.getElementsWithTracks({
					elements: selectedElements,
				})[0] ?? null)
			: null;
	const selectedMediaAsset = (() => {
		if (!selectedElement) {
			return null;
		}

		const { element } = selectedElement;
		if (!hasMediaId(element)) {
			return null;
		}

		return mediaAssets.find((asset) => asset.id === element.mediaId) ?? null;
	})();
	const canToggleSelectedSourceAudio =
		!!selectedElement &&
		canToggleSourceAudio(selectedElement.element, selectedMediaAsset);
	const sourceAudioLabel =
		selectedElement?.element.type === "video"
			? getSourceAudioActionLabel({
					element: selectedElement.element,
				})
			: "Extract audio";
	const isSelectedSourceAudioSeparated =
		selectedElement?.element.type === "video" &&
		isSourceAudioSeparated({
			element: selectedElement.element,
		});
	const canSaveSelectedClip =
		!!activeProject &&
		!!selectedElement &&
		!!selectedMediaAsset?.file &&
		(selectedElement.element.type === "video" ||
			selectedElement.element.type === "audio");

	const handleAction = ({
		action,
		event,
	}: {
		action: TActionWithOptionalArgs;
		event: React.MouseEvent;
	}) => {
		event.stopPropagation();
		invokeAction(action);
	};

	const handleSaveSelectionAsClip = async ({
		event,
	}: {
		event: React.MouseEvent;
	}) => {
		event.stopPropagation();

		if (
			!activeProject ||
			!selectedElement ||
			!selectedMediaAsset?.file ||
			(selectedElement.element.type !== "video" &&
				selectedElement.element.type !== "audio")
		) {
			return;
		}

		const element = selectedElement.element;
		const startSeconds = element.trimStart / TICKS_PER_SECOND;
		const durationSeconds = getSourceSpanAtClipTime({
			clipTime: element.duration / TICKS_PER_SECOND,
			retime: isRetimableElement(element) ? element.retime : undefined,
		});

		if (durationSeconds <= 0) {
			toast.error("The selected clip has no visible duration.");
			return;
		}

		setIsSavingSelectionClip(true);

		try {
			const clipFile = await extractMediaClip({
				file: selectedMediaAsset.file,
				kind: element.type === "video" ? "video" : "audio",
				startSeconds,
				durationSeconds,
				baseName: element.name || selectedMediaAsset.name,
				retimeRate: isRetimableElement(element)
					? element.retime?.rate
					: undefined,
				includeAudio:
					element.type === "video" && selectedMediaAsset.hasAudio === true,
			});
			const processedAssets = await processMediaAssets({ files: [clipFile] });
			const processedAsset = processedAssets[0];

			if (!processedAsset) {
				throw new Error("The selected clip could not be processed.");
			}

			const importedAsset = await editor.media.addMediaAsset({
				projectId: activeProject.metadata.id,
				asset: {
					...processedAsset,
					socialCopy: selectedMediaAsset.socialCopy,
				},
			});

			if (!importedAsset) {
				throw new Error("The selected clip could not be saved to media.");
			}

			useAssetsPanelStore.getState().requestRevealMedia(importedAsset.id);
			toast.success(
				`${element.name || selectedMediaAsset.name} saved to Assets.`,
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Could not save the selected clip.";
			toast.error("Save clip failed", { description: message });
		} finally {
			setIsSavingSelectionClip(false);
		}
	};

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={ScissorIcon} />}
					tooltip="Split element"
					onClick={({ event }) => handleAction({ action: "split", event })}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignLeftIcon} />}
					tooltip="Split left"
					onClick={({ event }) => handleAction({ action: "split-left", event })}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignRightIcon} />}
					tooltip="Split right"
					onClick={({ event }) =>
						handleAction({ action: "split-right", event })
					}
				/>

				<ToolbarButton
					icon={
						<HugeiconsIcon
							icon={isSelectedSourceAudioSeparated ? Unlink02Icon : Link02Icon}
						/>
					}
					tooltip={sourceAudioLabel}
					disabled={!canToggleSelectedSourceAudio}
					onClick={({ event }) =>
						handleAction({ action: "toggle-source-audio", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Copy01Icon} />}
					tooltip="Duplicate element"
					onClick={({ event }) =>
						handleAction({ action: "duplicate-selected", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={CloudUploadIcon} />}
					tooltip={
						isSavingSelectionClip
							? "Saving selected clip..."
							: "Save selected clip to Assets"
					}
					disabled={!canSaveSelectedClip || isSavingSelectionClip}
					onClick={handleSaveSelectionAsClip}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={SnowIcon} />}
					tooltip="Freeze frame (coming soon)"
					disabled={true}
					onClick={({ event: _event }) => {}}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Delete02Icon} />}
					tooltip="Delete element"
					onClick={({ event }) =>
						handleAction({ action: "delete-selected", event })
					}
				/>

				<div className="bg-border mx-1 h-6 w-px" />

				<RemoveSilenceButton />

				<div className="bg-border mx-1 h-6 w-px" />

				<Tooltip>
					<ToolbarButton
						icon={<HugeiconsIcon icon={Bookmark02Icon} />}
						isActive={isCurrentlyBookmarked}
						tooltip={isCurrentlyBookmarked ? "Remove bookmark" : "Add bookmark"}
						onClick={({ event }) =>
							handleAction({ action: "toggle-bookmark", event })
						}
					/>
				</Tooltip>

				<GraphEditorPopover
					open={graphEditor.open}
					onOpenChange={graphEditor.onOpenChange}
					value={
						graphEditor.state.status === "ready"
							? graphEditor.state.cubicBezier
							: null
					}
					message={graphEditor.state.message}
					componentOptions={graphEditor.state.componentOptions}
					activeComponentKey={graphEditor.state.activeComponentKey}
					onActiveComponentKeyChange={graphEditor.onActiveComponentKeyChange}
					onPreviewValue={graphEditor.onPreviewValue}
					onCommitValue={graphEditor.onCommitValue}
					onCancelPreview={graphEditor.onCancelPreview}
				>
					<ToolbarButton
						icon={<HugeiconsIcon icon={Chart03Icon} />}
						tooltip={graphEditor.tooltip}
						disabled={!graphEditor.canOpen}
						buttonWrapper={(button) =>
							graphEditor.canOpen ? (
								<PopoverTrigger asChild>{button}</PopoverTrigger>
							) : (
								button
							)
						}
					/>
				</GraphEditorPopover>
			</TooltipProvider>
		</div>
	);
}

function RemoveSilenceButton() {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const [threshold, setThreshold] = useState(3); // percentage
	const [minDuration, setMinDuration] = useState(0.5); // seconds
	const [isRunning, setIsRunning] = useState(false);

	const handleRun = async () => {
		const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
		const mediaAssets = editor.media.getAssets();
		if (!tracks) return;

		setIsRunning(true);
		try {
			const { detectSilentRanges } = await import("@/media/silence-detection");
			const { RemoveSilenceCommand } = await import(
				"@/commands/timeline/element/remove-silence"
			);

			const ranges = await detectSilentRanges({
				tracks,
				mediaAssets,
				threshold: threshold / 100,
				minDurationSeconds: minDuration,
			});

			if (ranges.length === 0) {
				toast.info("No silence detected", {
					description: "Try lowering the threshold or minimum duration.",
				});
				return;
			}

			editor.command.execute({ command: new RemoveSilenceCommand(ranges) });
			toast.success(`Removed ${ranges.length} silent section${ranges.length === 1 ? "" : "s"}`);
			setOpen(false);
		} catch (error) {
			toast.error("Failed to detect silence", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setIsRunning(false);
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<TooltipProvider delayDuration={500}>
				<Tooltip>
					<TooltipTrigger asChild>
						<PopoverTrigger asChild>
							<Button
								variant="text"
								size="icon"
								className="rounded-sm"
								aria-label="Remove silence"
							>
								<HugeiconsIcon icon={AudioWave01Icon} />
							</Button>
						</PopoverTrigger>
					</TooltipTrigger>
					<TooltipContent>Remove silence</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<PopoverContent className="w-72 p-4" align="start" side="top">
				<div className="flex flex-col gap-4">
					<div>
						<p className="text-sm font-medium leading-none">Remove silence</p>
						<p className="text-muted-foreground mt-1 text-xs">
							Cut out silent sections and close the gaps.
						</p>
					</div>

					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between">
							<Label className="text-xs">Silence threshold</Label>
							<span className="text-muted-foreground text-xs tabular-nums">
								{threshold}%
							</span>
						</div>
						<Slider
							min={1}
							max={20}
							step={1}
							value={[threshold]}
							onValueChange={([v]) => v !== undefined && setThreshold(v)}
						/>
						<p className="text-muted-foreground text-xs">
							Sections quieter than this will be removed.
						</p>
					</div>

					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between">
							<Label className="text-xs">Minimum duration</Label>
							<span className="text-muted-foreground text-xs tabular-nums">
								{minDuration.toFixed(1)}s
							</span>
						</div>
						<Slider
							min={0.1}
							max={2}
							step={0.1}
							value={[minDuration]}
							onValueChange={([v]) => v !== undefined && setMinDuration(v)}
						/>
						<p className="text-muted-foreground text-xs">
							Only remove silences longer than this.
						</p>
					</div>

					<Button
						className="w-full gap-2"
						onClick={handleRun}
						disabled={isRunning}
					>
						<HugeiconsIcon icon={AudioWave01Icon} className="size-4" />
						{isRunning ? "Detecting…" : "Detect & remove"}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function SceneSelector() {
	const editor = useEditor();
	const currentScene = editor.scenes.getActiveScene();

	return (
		<div>
			<SplitButton className="border-foreground/10 border">
				<SplitButtonLeft>{currentScene?.name || "No Scene"}</SplitButtonLeft>
				<SplitButtonSeparator />
				<ScenesView>
					<SplitButtonRight onClick={() => {}}>
						<HugeiconsIcon icon={Layers01Icon} className="size-4" />
					</SplitButtonRight>
				</ScenesView>
			</SplitButton>
		</div>
	);
}

function ToolbarRightSection({
	zoomLevel,
	minZoom,
	onZoomChange,
	onZoom,
}: {
	zoomLevel: number;
	minZoom: number;
	onZoomChange: (zoom: number) => void;
	onZoom: (options: { direction: "in" | "out" }) => void;
}) {
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={MagnetIcon} />}
					isActive={snappingEnabled}
					tooltip="Auto snapping"
					onClick={() => toggleSnapping()}
				/>

				<ToolbarButton
					icon={<OcRippleIcon size={24} className="scale-110" />}
					isActive={rippleEditingEnabled}
					tooltip="Ripple editing"
					onClick={() => toggleRippleEditing()}
				/>
			</TooltipProvider>

			<div className="bg-border mx-1 h-6 w-px" />

			<div className="flex items-center gap-1">
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "out" })}
				>
					<HugeiconsIcon icon={SearchMinusIcon} />
				</Button>
				<Slider
					className="w-28"
					value={[zoomToSlider({ zoomLevel, minZoom })]}
					onValueChange={(values) =>
						onZoomChange(sliderToZoom({ sliderPosition: values[0], minZoom }))
					}
					min={0}
					max={1}
					step={0.005}
				/>
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "in" })}
				>
					<HugeiconsIcon icon={SearchAddIcon} />
				</Button>
			</div>
		</div>
	);
}

function ToolbarButton({
	icon,
	tooltip,
	onClick,
	disabled,
	isActive,
	buttonWrapper,
}: {
	icon: React.ReactNode;
	tooltip: string;
	onClick?: ({ event }: { event: React.MouseEvent }) => void;
	disabled?: boolean;
	isActive?: boolean;
	buttonWrapper?: (button: React.ReactElement) => React.ReactElement;
}) {
	const button = (
		<Button
			variant={isActive ? "secondary" : "text"}
			size="icon"
			disabled={disabled}
			onClick={onClick ? (event) => onClick({ event }) : undefined}
			className={cn(
				"rounded-sm",
				disabled ? "cursor-not-allowed opacity-50" : "",
			)}
		>
			{icon}
		</Button>
	);
	const trigger = disabled ? (
		<span className="inline-flex">{button}</span>
	) : buttonWrapper ? (
		buttonWrapper(button)
	) : (
		button
	);

	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>{trigger}</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
