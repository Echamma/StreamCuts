import { create } from "zustand";

export const BOSS_VIDEO_ACCEPT =
	".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm";

export type BossStep = "upload" | "prompt" | "processing" | "done";

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
	longerFolderId: string;
	shortsFolderId: string;
	longerVideoCount: number;
	shortCount: number;
}

interface BossStore {
	step: BossStep;
	sourceVideo: BossSourceVideo | null;
	prompt: string;
	processingStep: BossProcessingStep | null;
	jobId: string | null;
	sourceDurationSeconds: number;
	errorMessage: string | null;
	result: BossResult | null;

	setSourceVideo: (video: BossSourceVideo | null) => void;
	setStep: (step: BossStep) => void;
	setPrompt: (prompt: string) => void;
	setProcessingStep: (step: BossProcessingStep | null) => void;
	setJobId: (jobId: string) => void;
	setSourceDuration: (seconds: number) => void;
	setError: (message: string | null) => void;
	setResult: (result: BossResult) => void;
	reset: () => void;
}

const initialState = () => ({
	step: "upload" as BossStep,
	sourceVideo: null,
	prompt: "",
	processingStep: null,
	jobId: null,
	sourceDurationSeconds: 0,
	errorMessage: null,
	result: null,
});

export const useBossStore = create<BossStore>()((set, get) => ({
	...initialState(),

	setSourceVideo: (sourceVideo) => {
		const previous = get().sourceVideo;
		if (previous?.url && previous.url !== sourceVideo?.url) {
			URL.revokeObjectURL(previous.url);
		}
		set({ sourceVideo });
	},

	setStep: (step) => set({ step }),
	setPrompt: (prompt) => set({ prompt }),
	setProcessingStep: (processingStep) => set({ processingStep }),
	setJobId: (jobId) => set({ jobId }),
	setSourceDuration: (sourceDurationSeconds) => set({ sourceDurationSeconds }),
	setError: (errorMessage) => set({ errorMessage }),
	setResult: (result) => set({ result }),

	reset: () => {
		const video = get().sourceVideo;
		if (video?.url) URL.revokeObjectURL(video.url);
		set(initialState());
	},
}));
