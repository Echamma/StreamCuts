import type { ParamValues } from "@/params";
import type { TransitionDefinition } from "@/transitions";
import { BaseNode } from "./base-node";
import type { ImageNode } from "./image-node";
import type { VideoNode } from "./video-node";
import type { ResolvedVisualSourceNodeState } from "./visual-node";

export interface TransitionNodeParams {
	timeOffset: number;
	duration: number;
	definition: TransitionDefinition;
	params: ParamValues;
	outgoingNode: VideoNode | ImageNode;
	incomingNode: VideoNode | ImageNode;
}

export interface ResolvedTransitionNodeState {
	progress: number;
	definition: TransitionDefinition;
	params: ParamValues;
	outgoing: ResolvedVisualSourceNodeState | null;
	incoming: ResolvedVisualSourceNodeState | null;
}

export class TransitionNode extends BaseNode<
	TransitionNodeParams,
	ResolvedTransitionNodeState
> {}
