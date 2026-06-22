import { create } from "zustand";

export const SUMMARIZE_VIDEO_ACCEPT =
	".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm";

export type SummarizeStep = "upload" | "config" | "processing" | "done";

export type SummarizeProcessingStep =
	| "uploading"
	| "transcribing"
	| "planning"
	| "rendering"
	| "adding_to_media";

export interface SummarizeSourceVideo {
	file: File;
	url: string;
	name: string;
	size: number;
	type: string;
	duration: number;
	width: number;
	height: number;
}

export interface SummarizeResult {
	folderId: string;
	mediaId: string;
	title: string;
	durationSeconds: number;
	segmentCount: number;
}

interface SummarizeStore {
	step: SummarizeStep;
	sourceVideo: SummarizeSourceVideo | null;
	targetMinutes: number;
	focus: string;
	processingStep: SummarizeProcessingStep | null;
	jobId: string | null;
	sourceDurationSeconds: number;
	errorMessage: string | null;
	result: SummarizeResult | null;

	setSourceVideo: (video: SummarizeSourceVideo | null) => void;
	setStep: (step: SummarizeStep) => void;
	setTargetMinutes: (minutes: number) => void;
	setFocus: (focus: string) => void;
	setProcessingStep: (step: SummarizeProcessingStep | null) => void;
	setJobId: (jobId: string) => void;
	setSourceDuration: (seconds: number) => void;
	setError: (message: string | null) => void;
	setResult: (result: SummarizeResult) => void;
	reset: () => void;
}

const initialState = () => ({
	step: "upload" as SummarizeStep,
	sourceVideo: null,
	targetMinutes: 5,
	focus: "",
	processingStep: null,
	jobId: null,
	sourceDurationSeconds: 0,
	errorMessage: null,
	result: null,
});

export const useSummarizeStore = create<SummarizeStore>()((set, get) => ({
	...initialState(),

	setSourceVideo: (sourceVideo) => {
		const previous = get().sourceVideo;
		if (previous?.url && previous.url !== sourceVideo?.url) {
			URL.revokeObjectURL(previous.url);
		}
		set({ sourceVideo });
	},

	setStep: (step) => set({ step }),
	setTargetMinutes: (targetMinutes) => set({ targetMinutes }),
	setFocus: (focus) => set({ focus }),
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
