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
	bossSummarizePlan,
	bossSummarizeRender,
	resolveLongToShortUrl,
	type BossTranscriptSegment,
} from "@/long-to-short/api";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import {
	useSummarizeStore,
	SUMMARIZE_VIDEO_ACCEPT,
	type SummarizeProcessingStep,
} from "./summarize-store";
import {
	VideoReplayIcon,
	CloudUploadIcon,
	ArrowLeft01Icon,
	Tick01Icon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";

const SUMMARIES_FOLDER = "summaries";

export function SummarizePanel() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const videoRef = useRef<HTMLVideoElement | null>(null);

	const step = useSummarizeStore((s) => s.step);
	const sourceVideo = useSummarizeStore((s) => s.sourceVideo);
	const targetMinutes = useSummarizeStore((s) => s.targetMinutes);
	const focus = useSummarizeStore((s) => s.focus);
	const processingStep = useSummarizeStore((s) => s.processingStep);
	const errorMessage = useSummarizeStore((s) => s.errorMessage);
	const result = useSummarizeStore((s) => s.result);

	const fileUpload = useFileUpload({
		accept: SUMMARIZE_VIDEO_ACCEPT,
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
			useSummarizeStore.getState().setSourceVideo({
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

		const store = useSummarizeStore.getState();
		const minutes = store.targetMinutes;
		const targetSeconds = Math.round(minutes * 60);

		if (!Number.isFinite(minutes) || minutes <= 0) {
			toast.error("Enter a target length in minutes.");
			return;
		}
		if (targetSeconds >= sourceVideo.duration) {
			toast.error("Target length must be shorter than the source video.", {
				description: `Source is ${formatTimestamp(sourceVideo.duration)} long.`,
			});
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

			// Step 3: Plan highlights with Gemini
			store.setProcessingStep("planning");
			const plan = await bossSummarizePlan({
				jobId: uploaded.jobId,
				segments: transcribed.segments as BossTranscriptSegment[],
				durationSeconds: uploaded.sourceDurationSeconds,
				targetSeconds,
				focus: store.focus.trim() || undefined,
			});

			// Step 4: Render & concatenate into one summary video
			store.setProcessingStep("rendering");
			const rendered = await bossSummarizeRender({
				jobId: uploaded.jobId,
				highlights: plan.highlights,
			});

			// Step 5: Add to Media
			store.setProcessingStep("adding_to_media");
			const folderId = useAssetsPanelStore.getState().createFolder(SUMMARIES_FOLDER);

			const blob = await fetch(
				resolveLongToShortUrl({ path: rendered.downloadUrl }),
			).then((r) => r.blob());
			const baseName = sourceVideo.name.replace(/\.[^.]+$/, "");
			const summaryFile = new File([blob], `${baseName} - Summary.mp4`, {
				type: "video/mp4",
			});
			const [processed] = await processMediaAssets({ files: [summaryFile] });
			if (!processed) {
				throw new Error("Could not process the rendered summary video.");
			}
			const created = await editor.media.addMediaAsset({
				projectId: activeProject.metadata.id,
				asset: { ...processed, folderId },
			});
			if (!created) {
				throw new Error("Could not add the summary to your media library.");
			}

			store.setResult({
				folderId,
				mediaId: created.id,
				title: rendered.title,
				durationSeconds: processed.duration ?? rendered.durationSeconds,
				segmentCount: rendered.segmentCount,
			});
			store.setProcessingStep(null);
			store.setStep("done");
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Something went wrong.";
			store.setError(message);
			store.setStep("config");
			store.setProcessingStep(null);
			toast.error("Summarize failed", { description: message });
		}
	};

	const handleViewInMedia = () => {
		if (!result) return;
		useAssetsPanelStore.getState().setActiveTab("media");
		useAssetsPanelStore.getState().setCurrentFolder(result.folderId);
		useAssetsPanelStore.getState().requestRevealMedia(result.mediaId);
	};

	return (
		<PanelView
			title="Summarize"
			actions={
				step !== "processing" && (step !== "upload" || sourceVideo) ? (
					<Button
						variant="outline"
						size="sm"
						onClick={() => useSummarizeStore.getState().reset()}
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
						onNext={() => useSummarizeStore.getState().setStep("config")}
					/>
				)}

				{step === "config" && (
					<ConfigStep
						sourceVideo={sourceVideo}
						targetMinutes={targetMinutes}
						focus={focus}
						errorMessage={errorMessage}
						onTargetMinutesChange={(v) =>
							useSummarizeStore.getState().setTargetMinutes(v)
						}
						onFocusChange={(v) => useSummarizeStore.getState().setFocus(v)}
						onBack={() => useSummarizeStore.getState().setStep("upload")}
						onProcess={() => void handleProcess()}
					/>
				)}

				{step === "processing" && (
					<ProcessingStep processingStep={processingStep} />
				)}

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
	sourceVideo: ReturnType<typeof useSummarizeStore.getState>["sourceVideo"];
	fileUpload: ReturnType<typeof useFileUpload>;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	onNext: () => void;
}) {
	return (
		<div className="rounded-md border bg-background p-3">
			<div className="mb-3">
				<h3 className="text-sm font-semibold">Upload a long video</h3>
				<p className="text-muted-foreground text-xs">
					Drop in a VOD (1–3+ hours) and Gemini will condense it into a single
					short summary video.
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
							Next: set length
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

// ── Config step ────────────────────────────────────────────────────────

const PRESET_MINUTES = [3, 5, 10, 15];

function ConfigStep({
	sourceVideo,
	targetMinutes,
	focus,
	errorMessage,
	onTargetMinutesChange,
	onFocusChange,
	onBack,
	onProcess,
}: {
	sourceVideo: ReturnType<typeof useSummarizeStore.getState>["sourceVideo"];
	targetMinutes: number;
	focus: string;
	errorMessage: string | null;
	onTargetMinutesChange: (v: number) => void;
	onFocusChange: (v: string) => void;
	onBack: () => void;
	onProcess: () => void;
}) {
	const targetSeconds = Math.round(targetMinutes * 60);
	const tooLong = sourceVideo ? targetSeconds >= sourceVideo.duration : false;

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
				<h3 className="text-sm font-semibold">How long should the summary be?</h3>
				<p className="text-muted-foreground text-xs">
					Gemini picks the best moments to fit your target length.
				</p>
			</div>

			<div className="mb-3 flex items-center gap-2">
				<input
					type="number"
					min={1}
					step={1}
					value={Number.isFinite(targetMinutes) ? targetMinutes : ""}
					onChange={(e) => onTargetMinutesChange(Number(e.target.value))}
					className="bg-accent/30 focus:ring-primary w-20 rounded-md border p-2 text-sm outline-none focus:ring-1"
				/>
				<span className="text-muted-foreground text-sm">minutes</span>
			</div>

			<div className="mb-4 flex flex-wrap gap-1.5">
				{PRESET_MINUTES.map((preset) => (
					<button
						key={preset}
						type="button"
						className={cn(
							"rounded-full px-2.5 py-1 text-xs transition-colors",
							targetMinutes === preset
								? "bg-primary text-primary-foreground"
								: "bg-accent hover:bg-accent/80",
						)}
						onClick={() => onTargetMinutesChange(preset)}
					>
						{preset} min
					</button>
				))}
			</div>

			<div className="mb-3">
				<p className="mb-1 block text-xs font-medium">
					Focus <span className="text-muted-foreground">(optional)</span>
				</p>
				<textarea
					className="bg-accent/30 focus:ring-primary w-full resize-none rounded-md border p-2.5 text-sm outline-none focus:ring-1"
					rows={2}
					placeholder="e.g. funniest moments, key decisions, only the gameplay"
					value={focus}
					onChange={(e) => onFocusChange(e.target.value)}
				/>
			</div>

			{tooLong && (
				<p className="text-destructive mb-3 text-xs font-medium">
					Target length must be shorter than the source video.
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
					disabled={!targetMinutes || targetMinutes <= 0 || tooLong}
				>
					<HugeiconsIcon icon={VideoReplayIcon} className="size-4" />
					Summarize with Gemini
				</Button>
			</div>
		</div>
	);
}

// ── Processing step ────────────────────────────────────────────────────

const PROCESSING_STEPS: {
	key: SummarizeProcessingStep;
	label: string;
	hint?: string;
}[] = [
	{ key: "uploading", label: "Uploading video" },
	{
		key: "transcribing",
		label: "Transcribing audio",
		hint: "This can take several minutes for long videos",
	},
	{ key: "planning", label: "Gemini picks the highlights" },
	{ key: "rendering", label: "Cutting & stitching the summary" },
	{ key: "adding_to_media", label: "Adding to Media" },
];

const STEP_PROGRESS: Record<SummarizeProcessingStep, number> = {
	uploading: 0.1,
	transcribing: 0.3,
	planning: 0.55,
	rendering: 0.8,
	adding_to_media: 0.95,
};

function ProcessingStep({
	processingStep,
}: {
	processingStep: SummarizeProcessingStep | null;
}) {
	const currentIndex = processingStep
		? PROCESSING_STEPS.findIndex((s) => s.key === processingStep)
		: -1;

	const progress = processingStep ? STEP_PROGRESS[processingStep] : 0;

	return (
		<div className="rounded-md border bg-background p-4">
			<p className="text-muted-foreground mb-4 text-xs">Summarizing your video...</p>

			<div className="mb-5 space-y-2.5">
				{PROCESSING_STEPS.map((s, i) => {
					const done = i < currentIndex;
					const active = i === currentIndex;
					return (
						<div key={s.key} className="flex items-start gap-2.5">
							<div className="mt-0.5 size-4 shrink-0">
								{done ? (
									<HugeiconsIcon icon={Tick01Icon} className="text-primary size-4" />
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
	result: NonNullable<ReturnType<typeof useSummarizeStore.getState>["result"]>;
	onViewInMedia: () => void;
}) {
	return (
		<div className="rounded-md border bg-background p-4">
			<div className="mb-4 flex items-center gap-2">
				<HugeiconsIcon icon={VideoReplayIcon} className="text-primary size-5" />
				<h3 className="text-sm font-semibold">Summary ready!</h3>
			</div>

			<div className="bg-accent/30 mb-5 flex items-center justify-between rounded-md border p-2.5">
				<div>
					<p className="text-sm font-medium">{result.title}</p>
					<p className="text-muted-foreground text-xs">
						{result.segmentCount}{" "}
						{result.segmentCount === 1 ? "highlight" : "highlights"} ·{" "}
						{formatTimestamp(result.durationSeconds)}
					</p>
				</div>
				<span className="text-muted-foreground text-xs">in {SUMMARIES_FOLDER}</span>
			</div>

			<Button className="w-full" onClick={onViewInMedia}>
				View in Media
			</Button>
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
