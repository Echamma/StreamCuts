"use client";

import { useRef } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { toast } from "sonner";
import { useFileUpload } from "@/media/use-file-upload";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import {
	bossSaveUpload,
	bossTranscribe,
	bossPlanCuts,
	bossRender,
	resolveLongToShortUrl,
	type BossTranscriptSegment,
	type BossChapter,
	type BossShort,
	type BossPlanningSettings,
} from "@/long-to-short/api";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import {
	useBossStore,
	BOSS_VIDEO_ACCEPT,
	DEFAULT_BOSS_LONGER_FOLDER_NAME,
	DEFAULT_BOSS_SHORTS_FOLDER_NAME,
	type BossProcessingStep,
	type BossSettings,
} from "./boss-store";
import {
	EXPORT_PLATFORM_PRESET_IDS,
	EXPORT_PRESETS,
	type ExportPlatformPresetId,
	isExportPlatformPresetId,
} from "@/export/presets";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { TTargetAspect } from "@/project/types";
import {
	SparklesIcon,
	CloudUploadIcon,
	ArrowLeft01Icon,
	Tick01Icon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";

function getTargetAspectForPlatform({
	platform,
}: {
	platform: ExportPlatformPresetId;
}): TTargetAspect | null {
	const preset = EXPORT_PRESETS[platform];
	const ratio = preset.width / preset.height;
	const labelByRatio: Array<[TTargetAspect, number]> = [
		["16:9", 16 / 9],
		["9:16", 9 / 16],
		["1:1", 1],
		["4:5", 4 / 5],
	];
	for (const [label, target] of labelByRatio) {
		if (Math.abs(ratio - target) < 0.01) return label;
	}
	return null;
}

export function BossPanel() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const videoRef = useRef<HTMLVideoElement | null>(null);

	const step = useBossStore((s) => s.step);
	const sourceVideo = useBossStore((s) => s.sourceVideo);
	const prompt = useBossStore((s) => s.prompt);
	const settings = useBossStore((s) => s.settings);
	const processingStep = useBossStore((s) => s.processingStep);
	const errorMessage = useBossStore((s) => s.errorMessage);
	const plannedCuts = useBossStore((s) => s.plannedCuts);
	const result = useBossStore((s) => s.result);

	const fileUpload = useFileUpload({
		accept: BOSS_VIDEO_ACCEPT,
		multiple: false,
		onFilesSelected: (files) => {
			const file = files[0];
			if (file) void stageSourceFile(file);
		},
	});

	const stageSourceFile = async (file: File) => {
		if (!isAcceptedVideoFile(file)) {
			toast.error("Unsupported file type", {
				description: "Use MP4, MOV, MKV, or WebM.",
			});
			return;
		}

		try {
			const metadata = await readVideoMetadata(file);
			const url = URL.createObjectURL(file);
			useBossStore.getState().setSourceVideo({
				file,
				url,
				name: file.name,
				size: file.size,
				type: file.type || "video/mp4",
				duration: metadata.duration,
				width: metadata.width,
				height: metadata.height,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Could not read the video.";
			toast.error("Could not read video", { description: message });
		}
	};

	const handlePlan = async () => {
		if (!sourceVideo) return;

		const store = useBossStore.getState();
		const currentPrompt = store.prompt.trim();
		const currentSettings = store.settings;

		if (!currentPrompt) {
			toast.error("Please describe how to cut the video.");
			return;
		}
		if (!currentSettings.includeLongerVideos && !currentSettings.includeShorts) {
			toast.error("Enable at least one output.", {
				description: "Turn on longer videos or shorts in Advanced settings.",
			});
			return;
		}

		store.setStep("processing");
		store.setError(null);
		store.setPlannedCuts(null);

		try {
			let currentJobId = store.jobId;
			let currentDurationSeconds = store.sourceDurationSeconds;
			let currentTranscript = store.transcriptSegments;

			if (!currentJobId) {
				// Step 1: Upload
				store.setProcessingStep("uploading");
				const uploaded = await bossSaveUpload({ video: sourceVideo.file });
				currentJobId = uploaded.jobId;
				currentDurationSeconds = uploaded.sourceDurationSeconds;
				store.setJobId(uploaded.jobId);
				store.setSourceDuration(uploaded.sourceDurationSeconds);
			}

			if (!currentJobId) {
				throw new Error("The upload did not return a valid job id.");
			}

			if (currentTranscript.length === 0) {
				// Step 2: Transcribe
				store.setProcessingStep("transcribing");
				const transcribed = await bossTranscribe({ jobId: currentJobId });
				currentTranscript = transcribed.segments as BossTranscriptSegment[];
				store.setTranscriptSegments(currentTranscript);
			}

			// Step 3: Plan cuts
			store.setProcessingStep("planning");
			const plan = await bossPlanCuts({
				jobId: currentJobId,
				prompt: currentPrompt,
				segments: currentTranscript,
				durationSeconds: currentDurationSeconds || sourceVideo.duration,
				settings: toBossPlanningSettings(currentSettings),
			});

			store.setPlannedCuts({
				longerSegments: plan.longerSegments as BossChapter[],
				shorts: plan.shorts as BossShort[],
			});
			store.setProcessingStep(null);
			store.setStep("review");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Something went wrong.";
			store.setError(message);
			store.setStep("prompt");
			store.setProcessingStep(null);
			toast.error("Planning failed", { description: message });
		}
	};

	const handleRender = async () => {
		if (!activeProject || !sourceVideo || !plannedCuts) return;

		const store = useBossStore.getState();
		const currentSettings = store.settings;
		const jobId = store.jobId;
		const preview = buildBossPreview({
			plannedCuts,
			settings: currentSettings,
			durationSeconds: store.sourceDurationSeconds || sourceVideo.duration,
		});

		if (!jobId) {
			toast.error("No planned job found.", {
				description: "Run Gemini planning again before rendering clips.",
			});
			return;
		}
		if (!currentSettings.includeLongerVideos && !currentSettings.includeShorts) {
			toast.error("Enable at least one output.", {
				description: "Turn on longer videos or shorts in Advanced settings.",
			});
			return;
		}

		const longerSegmentsToRender = currentSettings.includeLongerVideos
			? preview.longerSegments
			: [];
		const shortsToRender = currentSettings.includeShorts ? preview.shorts : [];

		if (longerSegmentsToRender.length === 0 && shortsToRender.length === 0) {
			toast.error("Your timing offsets removed every clip.", {
				description: "Adjust the preview timings before rendering.",
			});
			return;
		}

		store.setStep("processing");
		store.setError(null);

		// Snap the project's targetAspect to the selected platform so the
		// export pipeline (Pick 1.4) defaults to the right canvas size.
		const targetAspect = getTargetAspectForPlatform({
			platform: currentSettings.targetPlatform,
		});
		if (
			targetAspect &&
			activeProject.settings.targetAspect !== targetAspect
		) {
			await editor.project.updateSettings({
				settings: { targetAspect },
			});
		}

		try {
			// Step 4: Render requested clips
			store.setProcessingStep(
				currentSettings.includeLongerVideos
					? "rendering_longer"
					: "rendering_shorts",
			);
			const rendered = await bossRender({
				jobId,
				longerSegments: longerSegmentsToRender,
				shorts: shortsToRender,
			});

			// Step 5: Add to Media
			store.setProcessingStep("adding_to_media");

			const longerFolderName = currentSettings.includeLongerVideos
				? currentSettings.longerFolderName.trim() ||
					DEFAULT_BOSS_LONGER_FOLDER_NAME
				: null;
			const shortsFolderName = currentSettings.includeShorts
				? currentSettings.shortsFolderName.trim() ||
					DEFAULT_BOSS_SHORTS_FOLDER_NAME
				: null;
			const longerFolderId = longerFolderName
				? useAssetsPanelStore.getState().createFolder(longerFolderName)
				: null;
			const shortsFolderId = shortsFolderName
				? useAssetsPanelStore.getState().createFolder(shortsFolderName)
				: null;

			for (const clip of rendered.longerVideos) {
				if (!longerFolderId) continue;
				const blob = await fetch(resolveLongToShortUrl({ path: clip.downloadUrl })).then(
					(r) => r.blob(),
				);
				const clipFile = new File([blob], `${clip.title}.mp4`, { type: "video/mp4" });
				const [processed] = await processMediaAssets({ files: [clipFile] });
				if (!processed) continue;
				await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset: { ...processed, folderId: longerFolderId },
				});
			}

			for (const clip of rendered.shorts) {
				if (!shortsFolderId) continue;
				const blob = await fetch(resolveLongToShortUrl({ path: clip.downloadUrl })).then(
					(r) => r.blob(),
				);
				const clipFile = new File([blob], `${clip.title}.mp4`, { type: "video/mp4" });
				const [processed] = await processMediaAssets({ files: [clipFile] });
				if (!processed) continue;
				await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset: {
						...processed,
						folderId: shortsFolderId,
						socialCopy: {
							platform: "tiktok" as const,
							provider: "gemini" as const,
							title: clip.title,
							description: clip.description,
						},
					},
				});
			}

			const primaryFolderId = shortsFolderId ?? longerFolderId;
			if (!primaryFolderId) {
				throw new Error("No destination folder was created for the generated clips.");
			}

			store.setResult({
				primaryFolderId,
				longerFolderId,
				shortsFolderId,
				longerFolderName,
				shortsFolderName,
				longerVideoCount: rendered.longerVideos.length,
				shortCount: rendered.shorts.length,
			});
			store.setProcessingStep(null);
			store.setStep("done");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Something went wrong.";
			store.setError(message);
			store.setStep("review");
			store.setProcessingStep(null);
			toast.error("Rendering failed", { description: message });
		}
	};

	const handleViewInMedia = () => {
		if (!result) return;
		useAssetsPanelStore.getState().setActiveTab("media");
		useAssetsPanelStore.getState().setCurrentFolder(result.primaryFolderId);
	};

	return (
		<PanelView
			title="Boss"
			actions={
				step !== "processing" && (step !== "upload" || sourceVideo) ? (
					<Button
						variant="outline"
						size="sm"
						onClick={() => useBossStore.getState().reset()}
					>
						{step === "done" ? "Start over" : "Reset"}
					</Button>
				) : undefined
			}
		>
			<div className="flex h-full flex-col gap-4 pb-4">
				{step === "upload" && (
					<UploadStep
						sourceVideo={sourceVideo}
						fileUpload={fileUpload}
						videoRef={videoRef}
						onNext={() => useBossStore.getState().setStep("prompt")}
					/>
				)}

				{step === "prompt" && (
					<PromptStep
						sourceVideo={sourceVideo}
						prompt={prompt}
						settings={settings}
						errorMessage={errorMessage}
						onPromptChange={(v) => useBossStore.getState().setPrompt(v)}
						onSettingsChange={(nextSettings) =>
							useBossStore.getState().setSettings(nextSettings)
						}
						onBack={() => useBossStore.getState().setStep("upload")}
						onProcess={() => void handlePlan()}
					/>
				)}

				{step === "review" && sourceVideo && plannedCuts && (
					<ReviewStep
						sourceVideo={sourceVideo}
						prompt={prompt}
						settings={settings}
						plannedCuts={plannedCuts}
						errorMessage={errorMessage}
						onSettingsChange={(nextSettings) =>
							useBossStore.getState().setSettings(nextSettings)
						}
						onBack={() => useBossStore.getState().setStep("prompt")}
						onRender={() => void handleRender()}
					/>
				)}

				{step === "processing" && <ProcessingStep processingStep={processingStep} />}

				{step === "done" && result && (
					<DoneStep result={result} onViewInMedia={handleViewInMedia} />
				)}
			</div>
		</PanelView>
	);
}

// ── Upload step ────────────────────────────────────────────────────────

function UploadStep({
	sourceVideo,
	fileUpload,
	videoRef,
	onNext,
}: {
	sourceVideo: ReturnType<typeof useBossStore.getState>["sourceVideo"];
	fileUpload: ReturnType<typeof useFileUpload>;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	onNext: () => void;
}) {
	return (
		<div className="rounded-md border bg-background p-3">
			<div className="mb-3">
				<h3 className="text-sm font-semibold">Upload source video</h3>
				<p className="text-muted-foreground text-xs">
					Gemini will plan the cuts and create TikTok shorts automatically.
				</p>
			</div>

			<input {...fileUpload.fileInputProps} />

			{!sourceVideo ? (
				<div
					{...fileUpload.dragProps}
					className={cn(
						"border-muted-foreground/25 bg-accent/20 flex min-h-36 cursor-pointer items-center justify-center rounded-md border border-dashed p-4 text-center transition-colors",
						fileUpload.isDragOver && "border-primary bg-primary/5",
					)}
					onClick={() => fileUpload.openFilePicker()}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							fileUpload.openFilePicker();
						}
					}}
				>
					<div className="space-y-2">
						<HugeiconsIcon
							icon={CloudUploadIcon}
							className="text-muted-foreground mx-auto size-8"
						/>
						<p className="text-sm font-medium">Drop your video here</p>
						<p className="text-muted-foreground text-xs">MP4 · MOV · MKV · WebM</p>
					</div>
				</div>
			) : (
				<div className="space-y-3">
					<div className="overflow-hidden rounded-md border bg-black">
						{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
						<video
							ref={videoRef}
							src={sourceVideo.url}
							playsInline
							preload="metadata"
							controls
							className="aspect-video w-full"
						/>
					</div>

					<div className="text-muted-foreground grid grid-cols-3 gap-2 text-xs">
						<MetaChip label="Duration" value={formatTimestamp(sourceVideo.duration)} />
						<MetaChip
							label="Resolution"
							value={`${sourceVideo.width}×${sourceVideo.height}`}
						/>
						<MetaChip label="Size" value={formatFileSize(sourceVideo.size)} />
					</div>

					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							className="flex-1"
							onClick={() => fileUpload.openFilePicker()}
						>
							Change video
						</Button>
						<Button size="sm" className="flex-1" onClick={onNext}>
							Next: describe cuts
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

// ── Prompt step ────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
	"Cut at topic changes",
	"Split every 10 minutes",
	"Cut at natural pauses",
];

function PromptStep({
	sourceVideo,
	prompt,
	settings,
	errorMessage,
	onPromptChange,
	onSettingsChange,
	onBack,
	onProcess,
}: {
	sourceVideo: ReturnType<typeof useBossStore.getState>["sourceVideo"];
	prompt: string;
	settings: BossSettings;
	errorMessage: string | null;
	onPromptChange: (v: string) => void;
	onSettingsChange: (settings: Partial<BossSettings>) => void;
	onBack: () => void;
	onProcess: () => void;
}) {
	const hasNoOutputSelected =
		!settings.includeLongerVideos && !settings.includeShorts;

	return (
		<div className="rounded-md border bg-background p-3">
			{sourceVideo && (
				<div className="text-muted-foreground mb-3 flex items-center gap-1.5 text-xs">
					<span className="max-w-[160px] truncate font-medium text-foreground">
						{sourceVideo.name}
					</span>
					<span>·</span>
					<span>{formatTimestamp(sourceVideo.duration)}</span>
				</div>
			)}

			<div className="mb-3">
				<h3 className="text-sm font-semibold">How should Gemini cut this video?</h3>
				<p className="text-muted-foreground text-xs">
					Describe when to cut — by topic, speaker, mood, or anything else.
				</p>
			</div>

			<textarea
				className="bg-accent/30 focus:ring-primary w-full resize-none rounded-md border p-2.5 text-sm outline-none focus:ring-1"
				rows={4}
				placeholder="e.g. Cut every time I change topics, or when there's a natural pause between stories"
				value={prompt}
				onChange={(e) => onPromptChange(e.target.value)}
			/>

			<div className="mt-2 mb-4 flex flex-wrap gap-1.5">
				{EXAMPLE_PROMPTS.map((example) => (
					<button
						key={example}
						type="button"
						className="bg-accent hover:bg-accent/80 rounded-full px-2.5 py-1 text-xs transition-colors"
						onClick={() => onPromptChange(example)}
					>
						{example}
					</button>
				))}
			</div>

			<div className="mb-4 rounded-md border bg-accent/20 p-3">
				<div className="mb-2 flex flex-col gap-0.5">
					<p className="text-sm font-medium">Target platform</p>
					<p className="text-muted-foreground text-xs">
						Drives the project's target aspect and the default export preset.
					</p>
				</div>
				<Select
					value={settings.targetPlatform}
					onValueChange={(value) => {
						if (isExportPlatformPresetId(value)) {
							onSettingsChange({ targetPlatform: value });
						}
					}}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
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
			</div>

			<Section
				collapsible
				defaultOpen={false}
				sectionKey="boss-advanced-settings"
				className="mb-4 rounded-md border bg-accent/20"
				showBottomBorder={false}
			>
				<SectionHeader className="h-auto min-h-11 px-3 py-2">
					<div className="flex min-w-0 flex-col items-start gap-0.5">
						<SectionTitle>Advanced settings</SectionTitle>
						<p className="text-muted-foreground text-xs leading-5">
							{formatBossSettingsSummary(settings)}
						</p>
					</div>
				</SectionHeader>
				<SectionContent className="px-3 pb-3 pt-0">
					<SectionFields className="gap-4">
						<div className="grid gap-3 rounded-md border bg-background/70 p-3 sm:grid-cols-2">
							<OutputToggleField
								title="Longer videos"
								description="Import named chapter cuts into Media."
								checked={settings.includeLongerVideos}
								onCheckedChange={(checked) =>
									onSettingsChange({ includeLongerVideos: checked })
								}
							/>
							<OutputToggleField
								title="Shorts"
								description="Import TikTok-ready clips into Media."
								checked={settings.includeShorts}
								onCheckedChange={(checked) =>
									onSettingsChange({ includeShorts: checked })
								}
							/>
						</div>

						<div className="grid gap-3 sm:grid-cols-2">
							<SectionField label="Longer videos folder">
								<Input
									value={settings.longerFolderName}
									onChange={(e) =>
										onSettingsChange({ longerFolderName: e.target.value })
									}
									disabled={!settings.includeLongerVideos}
									placeholder={DEFAULT_BOSS_LONGER_FOLDER_NAME}
								/>
							</SectionField>
							<SectionField label="Shorts folder">
								<Input
									value={settings.shortsFolderName}
									onChange={(e) =>
										onSettingsChange({ shortsFolderName: e.target.value })
									}
									disabled={!settings.includeShorts}
									placeholder={DEFAULT_BOSS_SHORTS_FOLDER_NAME}
								/>
							</SectionField>
						</div>

						<div className="grid gap-3 rounded-md border bg-background/70 p-3 sm:grid-cols-2">
							<SectionField label="Min chapters">
								<Input
									type="number"
									min={1}
									max={20}
									value={settings.minChapters}
									onChange={(e) =>
										onSettingsChange({ minChapters: Number(e.target.value) })
									}
								/>
							</SectionField>
							<SectionField label="Max chapters">
								<Input
									type="number"
									min={settings.minChapters}
									max={20}
									value={settings.maxChapters}
									onChange={(e) =>
										onSettingsChange({ maxChapters: Number(e.target.value) })
									}
								/>
							</SectionField>
							<SectionField label="Min chapter seconds">
								<Input
									type="number"
									min={5}
									max={3600}
									value={settings.minChapterDurationSeconds}
									onChange={(e) =>
										onSettingsChange({
											minChapterDurationSeconds: Number(e.target.value),
										})
									}
								/>
							</SectionField>
							<div className="text-muted-foreground flex items-center text-xs leading-5">
								Gemini uses these limits when splitting the source into the named
								longer sections.
							</div>
						</div>

						<div className="rounded-md border bg-background/70 p-3">
							<p className="mb-3 text-sm font-medium">Cut timing offsets</p>
							<TimingOffsetFields
								settings={settings}
								onSettingsChange={onSettingsChange}
							/>
						</div>

						<div className="grid gap-3 rounded-md border bg-background/70 p-3 sm:grid-cols-2">
							<SectionField label="Min shorts per section">
								<Input
									type="number"
									min={1}
									max={5}
									value={settings.minShortsPerSegment}
									onChange={(e) =>
										onSettingsChange({
											minShortsPerSegment: Number(e.target.value),
										})
									}
									disabled={!settings.includeShorts}
								/>
							</SectionField>
							<SectionField label="Max shorts per section">
								<Input
									type="number"
									min={settings.minShortsPerSegment}
									max={5}
									value={settings.maxShortsPerSegment}
									onChange={(e) =>
										onSettingsChange({
											maxShortsPerSegment: Number(e.target.value),
										})
									}
									disabled={!settings.includeShorts}
								/>
							</SectionField>
							<SectionField label="Min short seconds">
								<Input
									type="number"
									min={5}
									max={180}
									value={settings.minShortDurationSeconds}
									onChange={(e) =>
										onSettingsChange({
											minShortDurationSeconds: Number(e.target.value),
										})
									}
									disabled={!settings.includeShorts}
								/>
							</SectionField>
							<SectionField label="Max short seconds">
								<Input
									type="number"
									min={settings.minShortDurationSeconds}
									max={180}
									value={settings.maxShortDurationSeconds}
									onChange={(e) =>
										onSettingsChange({
											maxShortDurationSeconds: Number(e.target.value),
										})
									}
									disabled={!settings.includeShorts}
								/>
							</SectionField>
						</div>
					</SectionFields>
				</SectionContent>
			</Section>

			{hasNoOutputSelected && (
				<p className="text-destructive mb-3 text-xs font-medium">
					Turn on longer videos or shorts in Advanced settings.
				</p>
			)}

			{errorMessage && (
				<p className="text-destructive mb-3 text-xs font-medium">{errorMessage}</p>
			)}

			<div className="flex gap-2">
				<Button variant="outline" size="sm" onClick={onBack}>
					<HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
					Back
				</Button>
				<Button
					size="sm"
					className="flex-1"
					onClick={onProcess}
					disabled={!prompt.trim() || hasNoOutputSelected}
				>
					<HugeiconsIcon icon={SparklesIcon} className="size-4" />
					Plan with Gemini
				</Button>
			</div>
		</div>
	);
}

function OutputToggleField({
	title,
	description,
	checked,
	onCheckedChange,
}: {
	title: string;
	description: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-start justify-between gap-3 rounded-md border bg-background/70 p-3">
			<div className="min-w-0">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-muted-foreground mt-1 text-xs leading-5">
					{description}
				</p>
			</div>
			<Switch aria-label={title} checked={checked} onCheckedChange={onCheckedChange} />
		</div>
	);
}

function TimingOffsetFields({
	settings,
	onSettingsChange,
}: {
	settings: BossSettings;
	onSettingsChange: (settings: Partial<BossSettings>) => void;
}) {
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			<SectionField label="Start shift (sec)">
				<Input
					type="number"
					min={-600}
					max={600}
					value={settings.startOffsetSeconds}
					onChange={(e) =>
						onSettingsChange({ startOffsetSeconds: Number(e.target.value) })
					}
				/>
			</SectionField>
			<SectionField label="End shift (sec)">
				<Input
					type="number"
					min={-600}
					max={600}
					value={settings.endOffsetSeconds}
					onChange={(e) =>
						onSettingsChange({ endOffsetSeconds: Number(e.target.value) })
					}
				/>
			</SectionField>
			<div className="text-muted-foreground text-xs leading-5 sm:col-span-2">
				Negative values cut earlier. Positive values cut later. The review step
				shows the adjusted timestamps before anything is rendered.
			</div>
		</div>
	);
}

function ReviewStep({
	sourceVideo,
	prompt,
	settings,
	plannedCuts,
	errorMessage,
	onSettingsChange,
	onBack,
	onRender,
}: {
	sourceVideo: ReturnType<typeof useBossStore.getState>["sourceVideo"];
	prompt: string;
	settings: BossSettings;
	plannedCuts: NonNullable<ReturnType<typeof useBossStore.getState>["plannedCuts"]>;
	errorMessage: string | null;
	onSettingsChange: (settings: Partial<BossSettings>) => void;
	onBack: () => void;
	onRender: () => void;
}) {
	const preview = buildBossPreview({
		plannedCuts,
		settings,
		durationSeconds: sourceVideo?.duration ?? 0,
	});
	const readyLongerCount = settings.includeLongerVideos
		? preview.longerSegments.length
		: 0;
	const readyShortCount = settings.includeShorts ? preview.shorts.length : 0;
	const hasRenderableOutput = readyLongerCount > 0 || readyShortCount > 0;

	return (
		<div className="rounded-md border bg-background p-3">
			{sourceVideo && (
				<div className="text-muted-foreground mb-3 flex items-center gap-1.5 text-xs">
					<span className="max-w-[160px] truncate font-medium text-foreground">
						{sourceVideo.name}
					</span>
					<span>·</span>
					<span>{formatTimestamp(sourceVideo.duration)}</span>
				</div>
			)}

			<div className="mb-3">
				<h3 className="text-sm font-semibold">Review Gemini cuts</h3>
				<p className="text-muted-foreground text-xs">
					Adjust the timing offsets below. The preview updates before the clips
					are rendered into Media.
				</p>
			</div>

			<div className="bg-accent/30 mb-4 rounded-md border p-3">
				<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Prompt
				</p>
				<p className="mt-1 text-sm">{prompt}</p>
			</div>

			<div className="mb-4 rounded-md border bg-background/70 p-3">
				<p className="mb-3 text-sm font-medium">Timing offsets</p>
				<TimingOffsetFields
					settings={settings}
					onSettingsChange={onSettingsChange}
				/>
			</div>

			<div className="text-muted-foreground mb-4 flex flex-wrap gap-2 text-xs">
				{settings.includeLongerVideos && (
					<span className="rounded-full border bg-accent/30 px-2.5 py-1">
						{readyLongerCount} longer {readyLongerCount === 1 ? "clip" : "clips"} ready
					</span>
				)}
				{settings.includeShorts && (
					<span className="rounded-full border bg-accent/30 px-2.5 py-1">
						{readyShortCount} short {readyShortCount === 1 ? "clip" : "clips"} ready
					</span>
				)}
			</div>

			{preview.invalidLongerCount > 0 && settings.includeLongerVideos && (
				<p className="text-destructive mb-3 text-xs font-medium">
					{preview.invalidLongerCount} longer{" "}
					{preview.invalidLongerCount === 1 ? "clip was" : "clips were"} dropped
					by the current offsets.
				</p>
			)}

			{preview.invalidShortCount > 0 && settings.includeShorts && (
				<p className="text-destructive mb-3 text-xs font-medium">
					{preview.invalidShortCount} short{" "}
					{preview.invalidShortCount === 1 ? "clip was" : "clips were"} dropped by
					the current offsets.
				</p>
			)}

			{settings.includeLongerVideos && (
				<PreviewSection
					className="mb-4"
					title="Longer videos"
					items={preview.longerItems}
				/>
			)}

			{settings.includeShorts && (
				<PreviewSection title="Shorts" items={preview.shortItems} />
			)}

			{errorMessage && (
				<p className="text-destructive mt-4 text-xs font-medium">{errorMessage}</p>
			)}

			<div className="mt-4 flex gap-2">
				<Button variant="outline" size="sm" onClick={onBack}>
					<HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
					Back
				</Button>
				<Button
					size="sm"
					className="flex-1"
					onClick={onRender}
					disabled={!hasRenderableOutput}
				>
					<HugeiconsIcon icon={SparklesIcon} className="size-4" />
					Render clips
				</Button>
			</div>
		</div>
	);
}

function PreviewSection({
	title,
	items,
	className,
}: {
	title: string;
	items: BossPreviewItem[];
	className?: string;
}) {
	return (
		<div className={className}>
			<div className="mb-2 flex items-center justify-between">
				<h4 className="text-sm font-semibold">{title}</h4>
				<span className="text-muted-foreground text-xs">
					Gemini vs adjusted timing
				</span>
			</div>
			<div className="space-y-2">
				{items.length > 0 ? (
					items.map((item, index) => (
						<PreviewItemCard key={`${title}-${index}-${item.title}`} item={item} />
					))
				) : (
					<div className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
						No clips available with the current settings.
					</div>
				)}
			</div>
		</div>
	);
}

function PreviewItemCard({ item }: { item: BossPreviewItem }) {
	return (
		<div className="rounded-md border bg-accent/20 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{item.title}</p>
					<p className="text-muted-foreground mt-1 text-xs">
						Gemini {formatTimestamp(item.geminiStartSeconds)} -{" "}
						{formatTimestamp(item.geminiEndSeconds)}
					</p>
					{item.valid ? (
						<p className="mt-1 text-xs">
							Final {formatTimestamp(item.startSeconds)} -{" "}
							{formatTimestamp(item.endSeconds)} ·{" "}
							{formatTimestamp(item.durationSeconds)}
						</p>
					) : (
						<p className="text-destructive mt-1 text-xs font-medium">
							Invalid after offsets. Increase the clip length before rendering.
						</p>
					)}
					{item.description && (
						<p className="text-muted-foreground mt-2 line-clamp-2 text-xs">
							{item.description}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Processing step ────────────────────────────────────────────────────

const PROCESSING_STEPS: { key: BossProcessingStep; label: string; hint?: string }[] = [
	{ key: "uploading", label: "Uploading video" },
	{
		key: "transcribing",
		label: "Transcribing audio",
		hint: "This can take several minutes for long videos",
	},
	{ key: "planning", label: "Gemini plans your cuts" },
	{ key: "rendering_longer", label: "Rendering longer segments" },
	{ key: "rendering_shorts", label: "Rendering TikTok shorts" },
	{ key: "adding_to_media", label: "Adding to Media" },
];

const STEP_PROGRESS: Record<BossProcessingStep, number> = {
	uploading: 0.1,
	transcribing: 0.25,
	planning: 0.5,
	rendering_longer: 0.65,
	rendering_shorts: 0.82,
	adding_to_media: 0.95,
};

function ProcessingStep({ processingStep }: { processingStep: BossProcessingStep | null }) {
	const currentIndex = processingStep
		? PROCESSING_STEPS.findIndex((s) => s.key === processingStep)
		: -1;

	const progress = processingStep ? STEP_PROGRESS[processingStep] : 0;

	return (
		<div className="rounded-md border bg-background p-4">
			<p className="text-muted-foreground mb-4 text-xs">Processing your video...</p>

			<div className="mb-5 space-y-2.5">
				{PROCESSING_STEPS.map((s, i) => {
					const done = i < currentIndex;
					const active = i === currentIndex;
					return (
						<div key={s.key} className="flex items-start gap-2.5">
							<div className="mt-0.5 size-4 shrink-0">
								{done ? (
									<HugeiconsIcon
										icon={Tick01Icon}
										className="text-primary size-4"
									/>
								) : active ? (
									<HugeiconsIcon
										icon={Loading03Icon}
										className="text-primary size-4 animate-spin"
									/>
								) : (
									<div className="border-muted-foreground/30 mt-1 size-3 rounded-full border" />
								)}
							</div>
							<div>
								<p
									className={cn(
										"text-sm",
										done && "text-muted-foreground line-through",
										active && "text-foreground font-medium",
										!done && !active && "text-muted-foreground/60",
									)}
								>
									{s.label}
								</p>
								{active && s.hint && (
									<p className="text-muted-foreground mt-0.5 text-xs">{s.hint}</p>
								)}
							</div>
						</div>
					);
				})}
			</div>

			<div className="bg-muted h-1.5 overflow-hidden rounded-full">
				<div
					className="bg-primary h-full rounded-full transition-[width] duration-700"
					style={{ width: `${progress * 100}%` }}
				/>
			</div>
			<p className="text-muted-foreground mt-1.5 text-right text-xs">
				{Math.round(progress * 100)}%
			</p>
		</div>
	);
}

// ── Done step ──────────────────────────────────────────────────────────

function DoneStep({
	result,
	onViewInMedia,
}: {
	result: NonNullable<ReturnType<typeof useBossStore.getState>["result"]>;
	onViewInMedia: () => void;
}) {
	return (
		<div className="rounded-md border bg-background p-4">
			<div className="mb-4 flex items-center gap-2">
				<HugeiconsIcon icon={SparklesIcon} className="text-primary size-5" />
				<h3 className="text-sm font-semibold">Done!</h3>
			</div>

			<div className="mb-5 space-y-2">
				{result.longerFolderName && (
					<FolderSummaryRow
						name={result.longerFolderName}
						count={result.longerVideoCount}
						description="Full-length segments"
					/>
				)}
				{result.shortsFolderName && (
					<FolderSummaryRow
						name={result.shortsFolderName}
						count={result.shortCount}
						description="TikTok-ready clips with captions"
					/>
				)}
			</div>

			<Button className="w-full" onClick={onViewInMedia}>
				View in Media
			</Button>
		</div>
	);
}

function FolderSummaryRow({
	name,
	count,
	description,
}: {
	name: string;
	count: number;
	description: string;
}) {
	return (
		<div className="bg-accent/30 flex items-center justify-between rounded-md border p-2.5">
			<div>
				<p className="text-sm font-medium">{name}</p>
				<p className="text-muted-foreground text-xs">{description}</p>
			</div>
			<span className="text-muted-foreground text-sm font-medium">
				{count} {count === 1 ? "clip" : "clips"}
			</span>
		</div>
	);
}

// ── Helpers ────────────────────────────────────────────────────────────

type BossPreviewItem = {
	title: string;
	description?: string;
	geminiStartSeconds: number;
	geminiEndSeconds: number;
	startSeconds: number;
	endSeconds: number;
	durationSeconds: number;
	valid: boolean;
};

function buildBossPreview({
	plannedCuts,
	settings,
	durationSeconds,
}: {
	plannedCuts: NonNullable<ReturnType<typeof useBossStore.getState>["plannedCuts"]>;
	settings: BossSettings;
	durationSeconds: number;
}) {
	const longerItems = plannedCuts.longerSegments.map((segment) =>
		buildPreviewItem({
			title: segment.title,
			geminiStartSeconds: segment.startSeconds,
			geminiEndSeconds: segment.endSeconds,
			durationSeconds,
			settings,
		}),
	);
	const shortItems = plannedCuts.shorts.map((short) =>
		buildPreviewItem({
			title: short.title,
			description: short.description,
			geminiStartSeconds: short.startSeconds,
			geminiEndSeconds: short.endSeconds,
			durationSeconds,
			settings,
		}),
	);

	return {
		longerSegments: longerItems
			.filter((item) => item.valid)
			.map((item) => ({
				startSeconds: item.startSeconds,
				endSeconds: item.endSeconds,
				title: item.title,
			})),
		shorts: shortItems
			.filter((item) => item.valid)
			.map((item) => ({
				startSeconds: item.startSeconds,
				endSeconds: item.endSeconds,
				title: item.title,
				description: item.description ?? "",
			})),
		longerItems,
		shortItems,
		invalidLongerCount: longerItems.filter((item) => !item.valid).length,
		invalidShortCount: shortItems.filter((item) => !item.valid).length,
	};
}

function buildPreviewItem({
	title,
	description,
	geminiStartSeconds,
	geminiEndSeconds,
	durationSeconds,
	settings,
}: {
	title: string;
	description?: string;
	geminiStartSeconds: number;
	geminiEndSeconds: number;
	durationSeconds: number;
	settings: BossSettings;
}): BossPreviewItem {
	const startSeconds = clampSeconds(
		{
			value: geminiStartSeconds + settings.startOffsetSeconds,
			durationSeconds,
		},
	);
	const endSeconds = clampSeconds(
		{
			value: geminiEndSeconds + settings.endOffsetSeconds,
			durationSeconds,
		},
	);
	const roundedStartSeconds = roundTo({ value: startSeconds, precision: 2 });
	const roundedEndSeconds = roundTo({ value: endSeconds, precision: 2 });
	const finalDurationSeconds = roundTo({
		value: Math.max(0, roundedEndSeconds - roundedStartSeconds),
		precision: 2,
	});

	return {
		title,
		description,
		geminiStartSeconds,
		geminiEndSeconds,
		startSeconds: roundedStartSeconds,
		endSeconds: roundedEndSeconds,
		durationSeconds: finalDurationSeconds,
		valid: finalDurationSeconds >= 1,
	};
}

function clampSeconds({
	value,
	durationSeconds,
}: {
	value: number;
	durationSeconds: number;
}) {
	return Math.min(Math.max(value, 0), Math.max(durationSeconds, 0));
}

function roundTo({
	value,
	precision,
}: {
	value: number;
	precision: number;
}) {
	const multiplier = 10 ** precision;
	return Math.round(value * multiplier) / multiplier;
}

function toBossPlanningSettings(settings: BossSettings): BossPlanningSettings {
	return {
		minChapters: settings.minChapters,
		maxChapters: settings.maxChapters,
		minChapterDurationSeconds: settings.minChapterDurationSeconds,
		minShortsPerSegment: settings.minShortsPerSegment,
		maxShortsPerSegment: settings.maxShortsPerSegment,
		minShortDurationSeconds: settings.minShortDurationSeconds,
		maxShortDurationSeconds: settings.maxShortDurationSeconds,
	};
}

function formatBossSettingsSummary(settings: BossSettings) {
	const outputs = [
		settings.includeLongerVideos ? "longer videos" : null,
		settings.includeShorts ? "shorts" : null,
	]
		.filter(Boolean)
		.join(" + ");

	return `${settings.minChapters}-${settings.maxChapters} chapters, min ${settings.minChapterDurationSeconds}s each · ${settings.minShortsPerSegment}-${settings.maxShortsPerSegment} shorts/section, ${settings.minShortDurationSeconds}-${settings.maxShortDurationSeconds}s · ${
		outputs || "no outputs enabled"
	}`;
}

function MetaChip({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border bg-accent/30 p-2">
			<span className="block text-[10px] uppercase tracking-wide">{label}</span>
			<span className="font-medium text-foreground">{value}</span>
		</div>
	);
}

function isAcceptedVideoFile(file: File) {
	const mimeMatches = [
		"video/mp4",
		"video/quicktime",
		"video/x-matroska",
		"video/webm",
	].includes(file.type);
	const extensionMatches = /\.(mp4|mov|mkv|webm)$/i.test(file.name);
	return mimeMatches || extensionMatches;
}

async function readVideoMetadata(file: File) {
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	try {
		return await new Promise<{ duration: number; width: number; height: number }>(
			(resolve, reject) => {
				video.preload = "metadata";
				video.src = url;
				video.onloadedmetadata = () => {
					resolve({
						duration: video.duration || 0,
						width: video.videoWidth || 0,
						height: video.videoHeight || 0,
					});
				};
				video.onerror = () => {
					reject(new Error("Could not read the uploaded video metadata."));
				};
			},
		);
	} finally {
		URL.revokeObjectURL(url);
		video.remove();
	}
}

function formatTimestamp(totalSeconds: number) {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = seconds % 60;
	return [hours, minutes, remainingSeconds]
		.map((v) => String(v).padStart(2, "0"))
		.join(":");
}

function formatFileSize(bytes: number) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
