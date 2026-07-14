import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEffect, useReducer, useRef, useState } from "react";
import {
	DEFAULT_TRANSCRIPTION_CHUNK_DURATION_SECONDS,
	extractTimelineAudioChunks,
} from "@/media/mediabunny";
import { useEditor } from "@/editor/use-editor";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type {
	CaptionChunk,
	TranscriptionLanguage,
	TranscriptionSegment,
} from "@/transcription/types";
import {
	downloadTranscriptionModel,
	fetchTranscriptionModelStatus,
	transcribeWithBackend,
} from "@/services/transcription/backend-service";
import { buildCaptionChunks } from "@/transcription/caption";
import {
	BACKEND_TRANSCRIPTION_MODELS,
	getBackendModel,
} from "@/transcription/backend-models";
import {
	setSelectedTranscriptionModel,
	useSelectedTranscriptionModel,
} from "@/transcription/model-store";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import { Spinner } from "@/components/ui/spinner";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { CaptionList } from "@/subtitles/components/caption-list";
import { CaptionStylePanel } from "@/subtitles/components/caption-style-panel";
import { seedBakedCaptionPresets } from "@/subtitles/caption-style-presets-store";

type ProcessingState =
	| { status: "idle"; error: string | null; warnings: string[] }
	| { status: "processing"; step: string };

type ProcessingAction =
	| { type: "start"; step: string }
	| { type: "update_step"; step: string }
	| { type: "succeed"; warnings: string[] }
	| { type: "fail"; error: string };

const IDLE_STATE: ProcessingState = {
	status: "idle",
	error: null,
	warnings: [],
};

/* eslint-disable opencut/prefer-object-params -- React reducers must accept (state, action). */
function processingReducer(
	state: ProcessingState,
	action: ProcessingAction,
): ProcessingState {
	switch (action.type) {
		case "start":
			return { status: "processing", step: action.step };
		case "update_step":
			if (state.status !== "processing") return state;
			return { status: "processing", step: action.step };
		case "succeed":
			return { status: "idle", error: null, warnings: action.warnings };
		case "fail":
			return { status: "idle", error: action.error, warnings: [] };
	}
}
/* eslint-enable opencut/prefer-object-params */

function offsetTranscriptionSegments({
	segments,
	offsetSeconds,
}: {
	segments: TranscriptionSegment[];
	offsetSeconds: number;
}): TranscriptionSegment[] {
	return segments.map((segment) => ({
		...segment,
		start: segment.start + offsetSeconds,
		end: segment.end + offsetSeconds,
		...(segment.words
			? {
					words: segment.words.map((word) => ({
						...word,
						start: word.start + offsetSeconds,
						end: word.end + offsetSeconds,
					})),
				}
			: {}),
	}));
}

export function Captions() {
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("auto");
	const [processing, dispatch] = useReducer(processingReducer, IDLE_STATE);
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const editor = useEditor();
	const selectedModel = useSelectedTranscriptionModel();
	const [modelStatus, setModelStatus] = useState<Record<string, boolean>>({});
	const [downloadingModel, setDownloadingModel] = useState<string | null>(null);

	const isProcessing = processing.status === "processing";

	// Seed the built-in caption style presets (Beast, Reels, Hormozi, …) on first
	// use of the captions workflow. Idempotent — a localStorage flag guards it.
	useEffect(() => {
		seedBakedCaptionPresets();
	}, []);

	useEffect(() => {
		let cancelled = false;
		const ids = BACKEND_TRANSCRIPTION_MODELS.map((model) => model.id);

		fetchTranscriptionModelStatus({ models: ids })
			.then((result) => {
				if (cancelled) return;
				const next: Record<string, boolean> = {};
				for (const entry of result.models) {
					next[entry.id] = entry.downloaded;
				}
				setModelStatus(next);
			})
			.catch(() => {
				// Backend may be offline; leave download state unknown.
			});

		return () => {
			cancelled = true;
		};
	}, []);

	const handleDownloadModel = async () => {
		setDownloadingModel(selectedModel);
		try {
			const result = await downloadTranscriptionModel({ model: selectedModel });
			setModelStatus((prev) => ({ ...prev, [result.id]: result.downloaded }));
			toast.success(
				`${getBackendModel(selectedModel)?.label ?? selectedModel} model downloaded.`,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Model download failed.";
			toast.error("Model download failed", { description: message });
		} finally {
			setDownloadingModel(null);
		}
	};

	const insertCaptions = ({
		captions,
	}: {
		captions: CaptionChunk[];
	}): boolean => {
		const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
		return trackId !== null;
	};

	const handleGenerateTranscript = async () => {
		const totalDuration = editor.timeline.getTotalDuration();
		if (totalDuration <= 0) {
			const message =
				"Captions are generated from the current timeline. Add your video or audio to the timeline first.";
			dispatch({ type: "fail", error: message });
			toast.error("Caption generation failed", {
				description: message,
			});
			return;
		}

		dispatch({ type: "start", step: "Preparing transcription..." });
		try {
			if (modelStatus[selectedModel] === false) {
				const label = getBackendModel(selectedModel)?.label ?? selectedModel;
				dispatch({
					type: "update_step",
					step: `Downloading ${label} model (first use)...`,
				});
				await downloadTranscriptionModel({ model: selectedModel });
				setModelStatus((prev) => ({ ...prev, [selectedModel]: true }));
			}

			const mergedSegments: TranscriptionSegment[] = [];
			const transcriptParts: string[] = [];
			let transcriptLanguage =
				selectedLanguage === "auto" ? "" : selectedLanguage;
			let transcribedChunkCount = 0;
			let activeChunkCount = 0;

			for await (const chunk of extractTimelineAudioChunks({
				tracks: editor.scenes.getActiveScene().tracks,
				mediaAssets: editor.media.getAssets(),
				totalDuration,
				windowDurationSeconds: DEFAULT_TRANSCRIPTION_CHUNK_DURATION_SECONDS,
				onProgress: (progress) => {
					dispatch({
						type: "update_step",
						step: `Preparing audio ${Math.round(progress)}%`,
					});
				},
			})) {
				if (!chunk.hasAudio) {
					continue;
				}
				if (!chunk.blob) {
					continue;
				}

				activeChunkCount += 1;
				dispatch({
					type: "update_step",
					step: `Transcribing chunk ${activeChunkCount}...`,
				});

				const result = await transcribeWithBackend({
					audioBlob: chunk.blob,
					language: selectedLanguage === "auto" ? undefined : selectedLanguage,
					model: selectedModel,
					profile: "captions",
				});

				transcribedChunkCount += 1;
				if (!transcriptLanguage && result.language) {
					transcriptLanguage = result.language;
				}
				if (result.text.trim()) {
					transcriptParts.push(result.text.trim());
				}
				if (result.segments.length > 0) {
					mergedSegments.push(
						...offsetTranscriptionSegments({
							segments: result.segments,
							offsetSeconds: chunk.startTime,
						}),
					);
				}
			}

			if (mergedSegments.length === 0) {
				const message =
					transcribedChunkCount === 0
						? "The timeline audio is silent or empty, so there was nothing to transcribe."
						: "The backend transcription completed, but it returned 0 segments. The timeline audio may be silent, the source may contain no speech, or speech detection filtered everything out.";
				dispatch({ type: "fail", error: message });
				toast.error("Caption generation failed", {
					description: message,
				});
				return;
			}

			dispatch({ type: "update_step", step: "Generating captions..." });
			mergedSegments.sort((left, right) => left.start - right.start);
			const captionChunks = buildCaptionChunks({ segments: mergedSegments });

			if (captionChunks.length === 0) {
				const message = `The backend returned ${mergedSegments.length} merged segment(s), but caption chunking produced 0 captions.`;
				dispatch({ type: "fail", error: message });
				toast.error("Caption generation failed", {
					description: message,
				});
				return;
			}

			if (!insertCaptions({ captions: captionChunks })) {
				const message = `Caption insertion failed after generating ${captionChunks.length} caption chunk(s).`;
				dispatch({ type: "fail", error: message });
				toast.error("Caption generation failed", {
					description: message,
				});
				return;
			}

			editor.project.setTranscript({
				transcript: {
					text: transcriptParts.join(" ").trim(),
					segments: mergedSegments,
					language: transcriptLanguage || "unknown",
					savedAt: new Date().toISOString(),
				},
			});

			dispatch({ type: "succeed", warnings: [] });
			toast.success("Captions added to the timeline.", {
				description: `Inserted ${captionChunks.length} caption(s) from ${mergedSegments.length} segment(s) across ${activeChunkCount} audio chunk(s).`,
			});
		} catch (error) {
			console.error("Transcription failed:", error);
			const message =
				error instanceof Error ? error.message : "An unexpected error occurred";
			dispatch({
				type: "fail",
				error: message,
			});
			toast.error("Caption generation failed", {
				description: message,
			});
		}
	};

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	const handleImportFile = async ({ file }: { file: File }) => {
		dispatch({ type: "start", step: "Reading subtitle file..." });
		try {
			const input = await file.text();
			const result = parseSubtitleFile({
				fileName: file.name,
				input,
			});

			if (result.captions.length === 0) {
				const message =
					"No valid subtitle cues were found in the subtitle file";
				dispatch({
					type: "fail",
					error: message,
				});
				toast.error("Subtitle import failed", {
					description: message,
				});
				return;
			}

			dispatch({ type: "update_step", step: "Importing subtitles..." });

			if (!insertCaptions({ captions: result.captions })) {
				const message = "No captions were generated.";
				dispatch({ type: "fail", error: message });
				toast.error("Subtitle import failed", {
					description: message,
				});
				return;
			}

			const nextWarnings = [...result.warnings];
			if (result.skippedCueCount > 0) {
				nextWarnings.unshift(
					`Imported ${result.captions.length} subtitle cue(s) and skipped ${result.skippedCueCount} malformed cue(s).`,
				);
			}

			dispatch({ type: "succeed", warnings: nextWarnings });
			toast.success("Subtitles imported to the timeline.");
		} catch (error) {
			console.error("Subtitle import failed:", error);
			const message =
				error instanceof Error ? error.message : "An unexpected error occurred";
			dispatch({
				type: "fail",
				error: message,
			});
			toast.error("Subtitle import failed", {
				description: message,
			});
		}
	};

	const handleFileChange = async ({
		event,
	}: {
		event: React.ChangeEvent<HTMLInputElement>;
	}) => {
		const file = event.target.files?.[0];
		if (event.target) {
			event.target.value = "";
		}
		if (!file) return;

		await handleImportFile({ file });
	};

	const handleLanguageChange = ({ value }: { value: string }) => {
		if (value === "auto") {
			setSelectedLanguage("auto");
			return;
		}

		const matchedLanguage = TRANSCRIPTION_LANGUAGES.find(
			(language) => language.code === value,
		);
		if (!matchedLanguage) return;
		setSelectedLanguage(matchedLanguage.code);
	};

	const error = processing.status === "idle" ? processing.error : null;
	const warnings = processing.status === "idle" ? processing.warnings : [];

	const savedTranscript = editor.project.getActive().transcript;

	const selectedModelMeta = getBackendModel(selectedModel);
	const selectedModelIsDownloaded = modelStatus[selectedModel];

	return (
		<PanelView
			title="Captions"
			contentClassName="px-0"
			actions={
				<div className="flex items-center gap-1.5">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={handleImportClick}
						disabled={isProcessing}
						className="items-center justify-center gap-1.5"
					>
						<HugeiconsIcon icon={CloudUploadIcon} />
						Import
					</Button>
				</div>
			}
			ref={containerRef}
		>
			<input
				ref={fileInputRef}
				type="file"
				accept=".srt,.ass"
				className="hidden"
				onChange={(event) => void handleFileChange({ event })}
			/>
			<Section showTopBorder={false} showBottomBorder={false}>
				<SectionContent className="flex flex-col gap-4 pt-1">
					<SectionFields>
						<SectionField label="Model">
							<Select
								value={selectedModel}
								disabled={isProcessing || downloadingModel !== null}
								onValueChange={(value) =>
									setSelectedTranscriptionModel({ model: value })
								}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a model" />
								</SelectTrigger>
								<SelectContent>
									{BACKEND_TRANSCRIPTION_MODELS.map((model) => (
										<SelectItem key={model.id} value={model.id}>
											{model.label} · {model.approxSize}
											{modelStatus[model.id] ? " ✓" : ""}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
						<SectionField label="Language">
							<Select
								value={selectedLanguage}
								disabled={isProcessing || downloadingModel !== null}
								onValueChange={(value) => handleLanguageChange({ value })}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a language" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">Auto detect</SelectItem>
									{TRANSCRIPTION_LANGUAGES.map((language) => (
										<SelectItem key={language.code} value={language.code}>
											{language.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>

					{selectedModelMeta && (
						<p className="text-[10px] text-muted-foreground">
							{selectedModelMeta.description}
							{selectedModelIsDownloaded === false
								? " — not downloaded yet"
								: selectedModelIsDownloaded
									? " — downloaded"
									: ""}
						</p>
					)}

					{selectedModelIsDownloaded === false && (
						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={handleDownloadModel}
							disabled={isProcessing || downloadingModel !== null}
						>
							{downloadingModel === selectedModel && (
								<Spinner className="mr-1" />
							)}
							{downloadingModel === selectedModel
								? `Downloading ${selectedModelMeta?.label ?? "model"}...`
								: `Download ${selectedModelMeta?.label ?? "model"} (${selectedModelMeta?.approxSize ?? ""})`}
						</Button>
					)}

					{savedTranscript && (
						<p className="text-[10px] text-muted-foreground">
							Transcript saved &mdash;{" "}
							{new Date(savedTranscript.savedAt).toLocaleDateString()}
						</p>
					)}

					<Button
						type="button"
						className="w-full"
						onClick={handleGenerateTranscript}
						disabled={isProcessing || downloadingModel !== null}
					>
						{isProcessing && <Spinner className="mr-1" />}
						{isProcessing ? processing.step : "Generate captions"}
					</Button>
					{error && (
						<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
							<p className="text-destructive text-sm">{error}</p>
						</div>
					)}
					{warnings.length > 0 && (
						<div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
							<ul className="space-y-1 text-sm text-amber-700">
								{warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					)}
				</SectionContent>
			</Section>
			<CaptionStylePanel />
			<Section showTopBorder showBottomBorder={false}>
				<SectionContent className="pt-2 pb-4">
					<CaptionList />
				</SectionContent>
			</Section>
		</PanelView>
	);
}
