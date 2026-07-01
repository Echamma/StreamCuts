"use client";

import { useState } from "react";
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
import { Check, Copy, Download, RotateCcw } from "lucide-react";
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
	type ExportPresetId,
} from "@/export/presets";
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

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
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

	const handlePresetChange = (next: ExportPresetId) => {
		setPresetId(next);
		if (next === "custom") return;
		const preset = getExportPreset({ id: next });
		setFormat(preset.format);
		setQuality(preset.quality);
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
			const exportOptions =
				presetId !== "custom" && isExportPlatformPresetId(presetId)
					? applyExportPreset({
							preset: getExportPreset({ id: presetId }),
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

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
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
													if (value === "custom" || isExportPlatformPresetId(value)) {
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
												</SelectContent>
											</Select>
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

								<div className="p-3 pt-0">
									<Button onClick={handleExport} className="w-full gap-2">
										<Download className="size-4" />
										Export
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
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
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
