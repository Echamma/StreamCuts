import type { ResolvedVisualNodeState, VisualNodeParams } from "./visual-node";
import { BaseNode } from "./base-node";

export interface CompoundNodeParams extends VisualNodeParams {
	compoundId: string;
}

export interface ResolvedCompoundNodeState extends ResolvedVisualNodeState {
	/** Time in the nested timeline, including the compound's source trim. */
	contentTime: number;
}

export class CompoundNode extends BaseNode<
	CompoundNodeParams,
	ResolvedCompoundNodeState
> {}
