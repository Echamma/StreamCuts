import type { ParamDefinition, ParamValues } from "@/params";

export interface CanvasTransitionRenderArgs {
	context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
	from: CanvasImageSource;
	to: CanvasImageSource;
	width: number;
	height: number;
	progress: number;
	params: ParamValues;
}

export interface TransitionDefinition {
	type: string;
	name: string;
	description: string;
	keywords: string[];
	defaultDurationSeconds?: number;
	params?: ParamDefinition[];
	render: (args: CanvasTransitionRenderArgs) => void;
}
