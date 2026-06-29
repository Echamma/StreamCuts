import { create } from "zustand";
import type {
	BossChapter,
	BossPlanningSettings,
	BossShort,
	BossTranscriptSegment,
} from "@/long-to-short/api";
import {
	EXPORT_PLATFORM_PRESET_IDS,
	type ExportPlatformPresetId,
	isExportPlatformPresetId,
} from "@/export/presets";

export const BOSS_VIDEO_ACCEPT =
	".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm";

export const DEFAULT_BOSS_LONGER_FOLDER_NAME = "longer videos";
export const DEFAULT_BOSS_SHORTS_FOLDER_NAME = "shortyshorts";

export type BossStep = "upload" | "prompt" | "processing" | "review" | "done";

export type BossProcessingStep =
	| "uploading"
	| "transcribing"
	| "planning"
	| "rendering_longer"
	| "rendering_shorts"
	| "adding_to_media";

export interface BossSourceVideo {
	file: File;
	url: string;
	name: string;
	size: number;
	type: string;
	duration: number;
	width: number;
	height: number;
}

export interface BossResult {
	primaryFolderId: string;
	longerFolderId: string | null;
	shortsFolderId: string | null;
	longerFolderName: string | null;
	shortsFolderName: string | null;
	longerVideoCount: number;
	shortCount: number;
}

export interface BossSettings extends BossPlanningSettings {
	includeLongerVideos: boolean;
	includeShorts: boolean;
	longerFolderName: string;
	shortsFolderName: string;
	startOffsetSeconds: number;
	endOffsetSeconds: number;
	/** Target social platform for generated shorts. Drives project.targetAspect
	 * and the default export preset. */
	targetPlatform: ExportPlatformPresetId;
}

export interface BossPlannedCuts {
	longerSegments: BossChapter[];
	shorts: BossShort[];
}

export const DEFAULT_BOSS_SETTINGS: BossSettings = {
	minChapters: 2,
	maxChapters: 10,
	minChapterDurationSeconds: 30,
	minShortsPerSegment: 1,
	maxShortsPerSegment: 3,
	minShortDurationSeconds: 15,
	maxShortDurationSeconds: 90,
	includeLongerVideos: true,
	includeShorts: true,
	longerFolderName: DEFAULT_BOSS_LONGER_FOLDER_NAME,
	shortsFolderName: DEFAULT_BOSS_SHORTS_FOLDER_NAME,
	startOffsetSeconds: 0,
	endOffsetSeconds: 0,
	targetPlatform: "tiktok-shorts",
};

export { EXPORT_PLATFORM_PRESET_IDS };

interface BossStore {
	step: BossStep;
	sourceVideo: BossSourceVideo | null;
	prompt: string;
	settings: BossSettings;
	processingStep: BossProcessingStep | null;
	jobId: string | null;
	sourceDurationSeconds: number;
	transcriptSegments: BossTranscriptSegment[];
	plannedCuts: BossPlannedCuts | null;
	errorMessage: string | null;
	result: BossResult | null;

	setSourceVideo: (video: BossSourceVideo | null) => void;
	setStep: (step: BossStep) => void;
	setPrompt: (prompt: string) => void;
	setSettings: (settings: Partial<BossSettings>) => void;
	setProcessingStep: (step: BossProcessingStep | null) => void;
	setJobId: (jobId: string) => void;
	setSourceDuration: (seconds: number) => void;
	setTranscriptSegments: (segments: BossTranscriptSegment[]) => void;
	setPlannedCuts: (cuts: BossPlannedCuts | null) => void;
	setError: (message: string | null) => void;
	setResult: (result: BossResult) => void;
	reset: () => void;
}

const initialState = () => ({
	step: "upload" as BossStep,
	sourceVideo: null,
	prompt: "",
	settings: { ...DEFAULT_BOSS_SETTINGS },
	processingStep: null,
	jobId: null,
	sourceDurationSeconds: 0,
	transcriptSegments: [],
	plannedCuts: null,
	errorMessage: null,
	result: null,
});

function clampInteger({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeBossSettings(settings: Partial<BossSettings>): BossSettings {
	const next = {
		...DEFAULT_BOSS_SETTINGS,
		...settings,
	};

	const minChapters = clampInteger({ value: next.minChapters, min: 1, max: 20 });
	const maxChapters = clampInteger({
		value: next.maxChapters,
		min: minChapters,
		max: 20,
	});
	const minChapterDurationSeconds = clampInteger({
		value: next.minChapterDurationSeconds,
		min: 5,
		max: 3600,
	});
	const minShortsPerSegment = clampInteger({
		value: next.minShortsPerSegment,
		min: 1,
		max: 5,
	});
	const maxShortsPerSegment = clampInteger({
		value: next.maxShortsPerSegment,
		min: minShortsPerSegment,
		max: 5,
	});
	const minShortDurationSeconds = clampInteger({
		value: next.minShortDurationSeconds,
		min: 5,
		max: 180,
	});
	const maxShortDurationSeconds = clampInteger({
		value: next.maxShortDurationSeconds,
		min: minShortDurationSeconds,
		max: 180,
	});
	const startOffsetSeconds = clampInteger({
		value: next.startOffsetSeconds,
		min: -600,
		max: 600,
	});
	const endOffsetSeconds = clampInteger({
		value: next.endOffsetSeconds,
		min: -600,
		max: 600,
	});

	return {
		...next,
		minChapters,
		maxChapters,
		minChapterDurationSeconds,
		minShortsPerSegment,
		maxShortsPerSegment,
		minShortDurationSeconds,
		maxShortDurationSeconds,
		includeLongerVideos: Boolean(next.includeLongerVideos),
		includeShorts: Boolean(next.includeShorts),
		longerFolderName: next.longerFolderName,
		shortsFolderName: next.shortsFolderName,
		startOffsetSeconds,
		endOffsetSeconds,
		targetPlatform: isExportPlatformPresetId(String(next.targetPlatform))
			? (next.targetPlatform as ExportPlatformPresetId)
			: DEFAULT_BOSS_SETTINGS.targetPlatform,
	};
}

export const useBossStore = create<BossStore>()((set, get) => ({
	...initialState(),

	setSourceVideo: (sourceVideo) => {
		const previous = get().sourceVideo;
		if (previous?.url && previous.url !== sourceVideo?.url) {
			URL.revokeObjectURL(previous.url);
		}
		set({
			sourceVideo,
			jobId: null,
			sourceDurationSeconds: 0,
			transcriptSegments: [],
			plannedCuts: null,
			processingStep: null,
			errorMessage: null,
			result: null,
		});
	},

	setStep: (step) => set({ step }),
	setPrompt: (prompt) => set({ prompt }),
	setSettings: (settings) =>
		set((state) => ({
			settings: normalizeBossSettings({
				...state.settings,
				...settings,
			}),
		})),
	setProcessingStep: (processingStep) => set({ processingStep }),
	setJobId: (jobId) => set({ jobId }),
	setSourceDuration: (sourceDurationSeconds) => set({ sourceDurationSeconds }),
	setTranscriptSegments: (transcriptSegments) => set({ transcriptSegments }),
	setPlannedCuts: (plannedCuts) => set({ plannedCuts }),
	setError: (errorMessage) => set({ errorMessage }),
	setResult: (result) => set({ result }),

	reset: () => {
		const video = get().sourceVideo;
		if (video?.url) URL.revokeObjectURL(video.url);
		set(initialState());
	},
}));
