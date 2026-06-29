import type { FrameRate } from "opencut-wasm";
import type { TScene } from "@/timeline/types";
import type { TranscriptionSegment } from "@/transcription/types";
import type { MediaTime } from "@/wasm";

export interface SavedTranscript {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
	savedAt: string;
}

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export const TARGET_ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type TTargetAspect = (typeof TARGET_ASPECTS)[number];

export function isTargetAspect(value: string): value is TTargetAspect {
	return TARGET_ASPECTS.some((aspect) => aspect === value);
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: MediaTime;
	createdAt: Date;
	updatedAt: Date;
}

export interface TProjectSettings {
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
	/** Conceptual target aspect for export / reframe pipelines. Optional — when
	 * omitted, downstream code falls back to the actual canvasSize aspect. */
	targetAspect?: TTargetAspect;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: MediaTime;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	version: number;
	timelineViewState?: TTimelineViewState;
	transcript?: SavedTranscript;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
