"use client";

import { useRef } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
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
} from "@/long-to-short/api";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import {
	useBossStore,
	BOSS_VIDEO_ACCEPT,
	type BossProcessingStep,
} from "./boss-store";
import {
	SparklesIcon,
	CloudUploadIcon,
	ArrowLeft01Icon,
	Tick01Icon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";

export function BossPanel() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const videoRef = useRef<HTMLVideoElement | null>(null);

	const step = useBossStore((s) => s.step);
	const sourceVideo = useBossStore((s) => s.sourceVideo);
	const prompt = useBossStore((s) => s.prompt);
	const processingStep = useBossStore((s) => s.processingStep);
	const errorMessage = useBossStore((s) => s.errorMessage);
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

	const handleProcess = async () => {
		if (!sourceVideo || !activeProject) return;

		const store = useBossStore.getState();
		const currentPrompt = store.prompt.trim();

		if (!currentPrompt) {
			toast.error("Please describe how to cut the video.");
			return;
		}

		store.setStep("processing");
		store.setError(null);

		try {
			// Step 1: Upload
			store.setProcessingStep("uploading");
			const uploaded = await bossSaveUpload({ video: sourceVideo.file });
			store.setJobId(uploaded.jobId);
			store.setSourceDuration(uploaded.sourceDurationSeconds);

			// Step 2: Transcribe
			store.setProcessingStep("transcribing");
			const transcribed = await bossTranscribe({ jobId: uploaded.jobId });

			// Step 3: Plan cuts
			store.setProcessingStep("planning");
			const plan = await bossPlanCuts({
				jobId: uploaded.jobId,
				prompt: currentPrompt,
				segments: transcribed.segments as BossTranscriptSegment[],
				durationSeconds: uploaded.sourceDurationSeconds,
			});

			// Step 4: Render longer segments
			store.setProcessingStep("rendering_longer");
			const rendered = await bossRender({
				jobId: uploaded.jobId,
				longerSegments: plan.longerSegments as BossChapter[],
				shorts: plan.shorts as BossShort[],
			});

			// Step 5: Add to Media
			store.setProcessingStep("adding_to_media");

			const longerFolderId = useAssetsPanelStore.getState().createFolder("longer videos");
			const shortsFolderId = useAssetsPanelStore.getState().createFolder("shortyshorts");

			for (const clip of rendered.longerVideos) {
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

			store.setResult({
				longerFolderId,
				shortsFolderId,
				longerVideoCount: rendered.longerVideos.length,
				shortCount: rendered.shorts.length,
			});
			store.setProcessingStep(null);
			store.setStep("done");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Something went wrong.";
			store.setError(message);
			store.setStep("prompt");
			store.setProcessingStep(null);
			toast.error("Processing failed", { description: message });
		}
	};

	const handleViewInMedia = () => {
		if (!result) return;
		useAssetsPanelStore.getState().setActiveTab("media");
		useAssetsPanelStore.getState().setCurrentFolder(result.shortsFolderId);
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
						errorMessage={errorMessage}
						onPromptChange={(v) => useBossStore.getState().setPrompt(v)}
						onBack={() => useBossStore.getState().setStep("upload")}
						onProcess={() => void handleProcess()}
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
	errorMessage,
	onPromptChange,
	onBack,
	onProcess,
}: {
	sourceVideo: ReturnType<typeof useBossStore.getState>["sourceVideo"];
	prompt: string;
	errorMessage: string | null;
	onPromptChange: (v: string) => void;
	onBack: () => void;
	onProcess: () => void;
}) {
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
					disabled={!prompt.trim()}
				>
					<HugeiconsIcon icon={SparklesIcon} className="size-4" />
					Process with Gemini
				</Button>
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
				<FolderSummaryRow
					name="longer videos"
					count={result.longerVideoCount}
					description="Full-length segments"
				/>
				<FolderSummaryRow
					name="shortyshorts"
					count={result.shortCount}
					description="TikTok-ready clips with captions"
				/>
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
