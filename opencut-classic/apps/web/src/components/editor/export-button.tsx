"use client";

import { useEffect, useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/export";
import { Check, Copy, Download, ListPlus, Play, RotateCcw, Trash2, X } from "lucide-react";
import {
	useExportQueue,
	addExportJob,
	removeExportJob,
	clearFinishedExportJobs,
	startExportQueue,
	cancelExportQueue,
} from "@/export/export-queue-store";
import type { ExportQueueJob } from "@/export/queue-runner";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportOptions,
	type ExportOutputTarget,
	type ExportQuality,
	type ExportSceneTarget,
} from "@/export";
import {
	EXPORT_PLATFORM_PRESET_IDS,
	EXPORT_PRESETS,
	applyExportPreset,
	getExportPreset,
	isExportPlatformPresetId,
	isUserExportPresetId,
	type ExportPresetId,
	type UserExportPresetId,
} from "@/export/presets";
import {
	getUserExportPreset,
	removeUserExportPreset,
	saveUserExportPreset,
	useUserExportPresets,
} from "@/export/user-presets-store";
import { Input } from "@/components/ui/input";
import { isAv1EncodeSupported } from "@/export/codec-support";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";

type SaveFilePickerLike = (options?: {
	suggestedName?: string;
	types?: Array<{
		description?: string;
		accept: Record<string, string[]>;
	}>;
}) => Promise<FileSystemFileHandle>;

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

function getShowSaveFilePicker(): SaveFilePickerLike | null {
	if (typeof window === "undefined") {
		return null;
	}

	return (
		(window as Window & { showSaveFilePicker?: SaveFilePickerLike })
			.showSaveFilePicker ?? null
	);
}

function getSceneLabel({
	sceneTarget,
	scenes,
}: {
	sceneTarget: ExportSceneTarget;
	scenes: Array<{ id: string; name: string }>;
}): string {
	return sceneTarget.mode === "specific"
		? `-${scenes.find((scene) => scene.id === sceneTarget.sceneId)?.name ?? "scene"}`
		: sceneTarget.mode === "all"
			? "-all"
			: "";
}

function buildExportFileName({
	projectName,
	sceneTarget,
	scenes,
	format,
}: {
	projectName: string;
	sceneTarget: ExportSceneTarget;
	scenes: Array<{ id: string; name: string }>;
	format: ExportFormat;
}): string {
	return `${projectName}${getSceneLabel({ sceneTarget, scenes })}${getExportFileExtension({ format })}`;
}

async function createExportOutputTarget({
	format,
	fileName,
}: {
	format: ExportFormat;
	fileName: string;
}): Promise<ExportOutputTarget | null> {
	const showSaveFilePicker = getShowSaveFilePicker();
	if (!showSaveFilePicker) {
		return { mode: "buffer" };
	}

	try {
		const handle = await showSaveFilePicker({
			suggestedName: fileName,
			types: [
				{
					description: `${format.toUpperCase()} video`,
					accept: {
						[getExportMimeType({ format })]: [getExportFileExtension({ format })],
					},
				},
			],
		});

		return {
			mode: "file-system",
			writable: await handle.createWritable(),
		};
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			return null;
		}
		throw error;
	}
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const { isExporting, progress } = useEditor((e) => e.project.getExportState());

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			// Closing this popover must not kill a running export. It closes on any
			// outside click or Escape, so cancelling here meant that clicking
			// anywhere in the app threw away the render. Leave the job running and
			// let the editor stay usable; only the explicit Cancel button stops it.
			// Clearing the state is only safe once nothing is in flight.
			if (!editor.project.getExportState().isExporting) {
				editor.project.clearExportState();
			}
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="primary"
					size="sm"
					className="gap-1.5"
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
				>
					<HugeiconsIcon icon={TransitionTopIcon} className="size-3.5" />
					{/* A background export is otherwise invisible once the popover is
					    closed, so the trigger doubles as its progress readout. */}
					{isExporting
						? `Exporting ${Math.round(progress * 100)}%`
						: "Export"}
				</Button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const scenes = useEditor((e) => e.scenes.getScenes());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, phase, statusText, result: exportResult } = exportState;
	const { isRunning: isQueueRunning } = useExportQueue();
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [sceneTarget, setSceneTarget] = useState<ExportSceneTarget>({
		mode: "current",
	});
	const [presetId, setPresetId] = useState<ExportPresetId>(() => {
		const targetAspect = activeProject?.settings.targetAspect;
		if (targetAspect === "9:16") return "tiktok-shorts";
		if (targetAspect === "1:1") return "instagram-square";
		if (targetAspect === "4:5") return "instagram-portrait";
		if (targetAspect === "16:9") return "youtube-1080p";
		return "custom";
	});
	const userPresets = useUserExportPresets();
	const [savePresetName, setSavePresetName] = useState<string>("");
	const [isNamingPreset, setIsNamingPreset] = useState<boolean>(false);
	const [isAv1Supported, setIsAv1Supported] = useState<boolean>(false);

	useEffect(() => {
		let alive = true;
		isAv1EncodeSupported().then((supported) => {
			if (alive) setIsAv1Supported(supported);
		});
		return () => {
			alive = false;
		};
	}, []);

	const handlePresetChange = (next: ExportPresetId) => {
		setPresetId(next);
		if (next === "custom") return;
		if (isUserExportPresetId(next)) {
			const userPreset = getUserExportPreset({ id: next });
			if (userPreset) {
				setFormat(userPreset.format);
				setQuality(userPreset.quality);
			}
			return;
		}
		const preset = getExportPreset({ id: next });
		setFormat(preset.format);
		setQuality(preset.quality);
	};

	// Resolve the preset object that drives canvas size + should be applied on export.
	const resolvedPreset =
		presetId === "custom"
			? null
			: isUserExportPresetId(presetId)
				? getUserExportPreset({ id: presetId })
				: getExportPreset({ id: presetId });

	const canSaveAsPreset = resolvedPreset !== null;

	const handleSavePreset = () => {
		if (!resolvedPreset || !activeProject) return;
		saveUserExportPreset({
			name: savePresetName,
			options: {
				format,
				quality,
				canvasSizeOverride: {
					width: resolvedPreset.width,
					height: resolvedPreset.height,
				},
			},
			fps: activeProject.settings.fps,
		});
		setSavePresetName("");
		setIsNamingPreset(false);
	};

	const handleRemoveUserPreset = (id: UserExportPresetId) => {
		removeUserExportPreset({ id });
		if (presetId === id) setPresetId("custom");
	};

	const handleExport = async () => {
		if (!activeProject) return;

		try {
			const fileName = buildExportFileName({
				projectName: activeProject.metadata.name,
				sceneTarget,
				scenes,
				format,
			});
			const outputTarget = await createExportOutputTarget({
				format,
				fileName,
			});
			if (!outputTarget) {
				return;
			}

			const baseOptions: ExportOptions = {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
				sceneTarget,
				outputTarget,
			};
			const exportOptions = resolvedPreset
				? applyExportPreset({
						preset: resolvedPreset,
						options: baseOptions,
					})
				: baseOptions;

			const result = await editor.project.export({
				options: exportOptions,
			});

			if (result.cancelled) {
				editor.project.clearExportState();
				return;
			}

			if (result.success) {
				if (result.buffer) {
					downloadBuffer({
						buffer: result.buffer,
						filename: fileName,
						mimeType: getExportMimeType({ format }),
					});
				}

				if (result.buffer || result.wroteToFile) {
					editor.project.clearExportState();
					onOpenChange(false);
				}
			}
		} catch (error) {
			console.error("Failed to start export:", error);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	const buildQueueOptions = (): {
		name: string;
		options: ExportOptions;
	} | null => {
		if (!activeProject) return null;
		const baseOptions: ExportOptions = {
			format,
			quality,
			fps: activeProject.settings.fps,
			includeAudio: shouldIncludeAudio,
			sceneTarget,
		};
		const options = resolvedPreset
			? applyExportPreset({
					preset: resolvedPreset,
					options: baseOptions,
				})
			: baseOptions;
		const name = `${activeProject.metadata.name}${getSceneLabel({ sceneTarget, scenes })}`;
		return { name, options };
	};

	const handleAddToQueue = () => {
		const built = buildQueueOptions();
		if (!built) return;
		addExportJob({ name: built.name, options: built.options });
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success && !isQueueRunning ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting
								? (phase === "audio"
									? "Preparing audio"
									: phase === "finalizing"
										? "Finishing up"
										: "Encoding video")
								: "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={true}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Preset</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<Select
												value={presetId}
												onValueChange={(value) => {
													if (
														value === "custom" ||
														isExportPlatformPresetId(value) ||
														isUserExportPresetId(value)
													) {
														handlePresetChange(value as ExportPresetId);
													}
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="custom">Custom</SelectItem>
													{EXPORT_PLATFORM_PRESET_IDS.map((id) => {
														const preset = EXPORT_PRESETS[id];
														return (
															<SelectItem key={id} value={id}>
																<div className="flex flex-col items-start">
																	<span>{preset.name}</span>
																	<span className="text-muted-foreground text-xs">
																		{preset.description}
																	</span>
																</div>
															</SelectItem>
														);
													})}
													{userPresets.length > 0 && (
														<div className="border-t my-1" />
													)}
													{userPresets.map((preset) => (
														<SelectItem key={preset.id} value={preset.id}>
															<div className="flex flex-col items-start">
																<span>{preset.name}</span>
																<span className="text-muted-foreground text-xs">
																	{preset.description} · saved
																</span>
															</div>
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											{isNamingPreset ? (
												<div className="mt-2 flex items-center gap-2">
													<Input
														// eslint-disable-next-line jsx-a11y/no-autofocus -- input appears in response to a click; focusing it avoids a stray tab.
														autoFocus
														value={savePresetName}
														onChange={(event) => setSavePresetName(event.target.value)}
														placeholder="Preset name"
														className="h-8 text-xs"
														onKeyDown={(event) => {
															if (event.key === "Enter") handleSavePreset();
															if (event.key === "Escape") {
																setIsNamingPreset(false);
																setSavePresetName("");
															}
														}}
													/>
													<Button
														type="button"
														size="sm"
														variant="secondary"
														className="h-8 px-2 text-xs"
														onClick={handleSavePreset}
													>
														Save
													</Button>
													<Button
														type="button"
														size="sm"
														variant="ghost"
														className="h-8 px-2 text-xs"
														onClick={() => {
															setIsNamingPreset(false);
															setSavePresetName("");
														}}
													>
														<X className="size-3" />
													</Button>
												</div>
											) : (
												<div className="mt-2 flex items-center justify-between gap-2">
													<Button
														type="button"
														size="sm"
														variant="secondary"
														className="h-7 px-2 text-xs"
														disabled={!canSaveAsPreset}
														onClick={() => {
															setSavePresetName(
																resolvedPreset ? `${resolvedPreset.name} (mine)` : "",
															);
															setIsNamingPreset(true);
														}}
														title={
															canSaveAsPreset
																? "Save current preset with your own name"
																: "Select a preset first to save a variant of it"
														}
													>
														Save as preset…
													</Button>
													{isUserExportPresetId(presetId) && (
														<Button
															type="button"
															size="sm"
															variant="ghost"
															className="h-7 px-2 text-xs text-destructive"
															onClick={() =>
																handleRemoveUserPreset(presetId as UserExportPresetId)
															}
														>
															<Trash2 className="mr-1 size-3" />
															Delete preset
														</Button>
													)}
												</div>
											)}
										</SectionContent>
									</Section>

									<Section
										collapsible
										defaultOpen={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
												{isAv1Supported && (
													<div className="flex items-center space-x-2">
														<RadioGroupItem value="webm-av1" id="webm-av1" />
														<Label htmlFor="webm-av1">
															WebM (AV1) - Smallest file, newer codec
														</Label>
													</div>
												)}
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low - Smallest file size</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium - Balanced</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High - Recommended</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very high - Largest file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>

									{scenes.length > 1 && (
										<Section collapsible defaultOpen={false}>
											<SectionHeader>
												<SectionTitle>Scene</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<RadioGroup
													value={
														sceneTarget.mode === "specific"
															? `specific:${sceneTarget.sceneId}`
															: sceneTarget.mode
													}
													onValueChange={(value) => {
														if (value === "current") {
															setSceneTarget({ mode: "current" });
														} else if (value === "all") {
															setSceneTarget({ mode: "all" });
														} else if (value.startsWith("specific:")) {
															setSceneTarget({
																mode: "specific",
																sceneId: value.slice("specific:".length),
															});
														}
													}}
												>
													<div className="flex items-center space-x-2">
														<RadioGroupItem value="current" id="scene-current" />
														<Label htmlFor="scene-current">Current scene</Label>
													</div>
													{scenes.map((scene) => (
														<div key={scene.id} className="flex items-center space-x-2">
															<RadioGroupItem
																value={`specific:${scene.id}`}
																id={`scene-${scene.id}`}
															/>
															<Label htmlFor={`scene-${scene.id}`}>
																{scene.name}
															</Label>
														</div>
													))}
													<div className="flex items-center space-x-2">
														<RadioGroupItem value="all" id="scene-all" />
														<Label htmlFor="scene-all">
															All scenes (merged)
														</Label>
													</div>
												</RadioGroup>
											</SectionContent>
										</Section>
									)}
								</div>

								<div className="flex gap-2 p-3 pt-0">
									<Button
										onClick={handleExport}
										disabled={isQueueRunning}
										className="flex-1 gap-2"
									>
										<Download className="size-4" />
										Export
									</Button>
									<Button
										variant="outline"
										onClick={handleAddToQueue}
										disabled={isQueueRunning}
										className="gap-2"
										title="Add these settings to the export queue"
									>
										<ListPlus className="size-4" />
										Queue
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
									{statusText ? (
										<p className="text-muted-foreground text-xs">{statusText}</p>
									) : null}
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={
										isQueueRunning
											? () => cancelExportQueue({ editor })
											: handleCancel
									}
								>
									{isQueueRunning ? "Cancel queue" : "Cancel"}
								</Button>
							</div>
						)}

						<ExportQueueSection />
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}

function jobStatusColor({ status }: { status: ExportQueueJob["status"] }): string {
	if (status === "done") return "text-constructive";
	if (status === "failed") return "text-destructive";
	return "text-muted-foreground";
}

function ExportQueueRow({ job }: { job: ExportQueueJob }) {
	return (
		<div className="flex items-center gap-2 text-xs">
			<span className="flex-1 truncate" title={job.name}>
				{job.name}
			</span>
			{job.status === "running" ? (
				<span className="text-muted-foreground tabular-nums">
					{Math.round(job.progress * 100)}%
				</span>
			) : (
				<span
					className={cn("capitalize", jobStatusColor({ status: job.status }))}
				>
					{job.status}
				</span>
			)}
			{job.status !== "running" && (
				<button
					type="button"
					aria-label={`Remove ${job.name} from queue`}
					className="text-muted-foreground hover:text-destructive"
					onClick={() => removeExportJob({ id: job.id })}
				>
					<X className="size-3" />
				</button>
			)}
		</div>
	);
}

export function ExportQueueSection() {
	const editor = useEditor();
	const { jobs, isRunning } = useExportQueue();

	if (jobs.length === 0) return null;

	const hasPending = jobs.some((job) => job.status === "pending");
	const hasFinished = jobs.some(
		(job) =>
			job.status === "done" ||
			job.status === "failed" ||
			job.status === "cancelled",
	);

	return (
		<div className="flex flex-col gap-2 border-t p-3">
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium">
					Export queue ({jobs.length})
				</span>
				<div className="flex items-center gap-1.5">
					{hasFinished && !isRunning ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							onClick={clearFinishedExportJobs}
						>
							<Trash2 className="size-3" />
							Clear done
						</Button>
					) : null}
					{isRunning ? (
						<Button
							variant="outline"
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={() => cancelExportQueue({ editor })}
						>
							Cancel
						</Button>
					) : (
						<Button
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							disabled={!hasPending}
							onClick={() => void startExportQueue({ editor })}
						>
							<Play className="size-3" />
							Start
						</Button>
					)}
				</div>
			</div>
			<div className="flex flex-col gap-1.5">
				{jobs.map((job) => (
					<ExportQueueRow key={job.id} job={job} />
				))}
			</div>
		</div>
	);
}
