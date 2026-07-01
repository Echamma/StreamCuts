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

const TARGET_ASPECT_DEFAULT_SIZES: Record<TTargetAspect, TCanvasSize> = {
	"16:9": { width: 1920, height: 1080 },
	"9:16": { width: 1080, height: 1920 },
	"1:1": { width: 1080, height: 1080 },
	"4:5": { width: 1080, height: 1350 },
};

const TARGET_ASPECT_RATIO_TOLERANCE = 0.01;

function getTargetAspectRatio(aspect: TTargetAspect): number {
	const [num, den] = aspect.split(":").map(Number);
	return num / den;
}

export function canvasSizeMatchesTargetAspect({
	canvasSize,
	targetAspect,
}: {
	canvasSize: TCanvasSize;
	targetAspect: TTargetAspect;
}): boolean {
	if (canvasSize.width <= 0 || canvasSize.height <= 0) return false;
	const actual = canvasSize.width / canvasSize.height;
	const target = getTargetAspectRatio(targetAspect);
	return Math.abs(actual - target) < TARGET_ASPECT_RATIO_TOLERANCE;
}

export function getTargetAspectDefaultSize({
	targetAspect,
}: {
	targetAspect: TTargetAspect;
}): TCanvasSize {
	return TARGET_ASPECT_DEFAULT_SIZES[targetAspect];
}

/** Resolve the canvas size for export. Priority: explicit override > project
 * canvasSize when it matches targetAspect (or no targetAspect set) > default
 * dimensions for the project's targetAspect. */
export function resolveExportCanvasSize({
	project,
	canvasSizeOverride,
}: {
	project: TProject;
	canvasSizeOverride?: TCanvasSize;
}): TCanvasSize {
	if (canvasSizeOverride) return canvasSizeOverride;
	const { targetAspect, canvasSize } = project.settings;
	if (!targetAspect) return canvasSize;
	if (canvasSizeMatchesTargetAspect({ canvasSize, targetAspect })) {
		return canvasSize;
	}
	return getTargetAspectDefaultSize({ targetAspect });
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
