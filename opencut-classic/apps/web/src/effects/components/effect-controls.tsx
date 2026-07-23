import type { ParamValue, ParamValues } from "@/params";
import { ColorWheelsControl } from "./color-wheels-control";

/** Props every custom effect control receives (mirrors the generic param path). */
export interface EffectControlProps {
	values: ParamValues;
	previewParam: (key: string) => (value: ParamValue) => void;
	onCommit: () => void;
}

/**
 * Effect types that render a bespoke control instead of the generic slider list.
 * UI-only — the effect *definition* stays a pure data module (no React import).
 */
const EFFECT_CONTROLS: Record<
	string,
	(props: EffectControlProps) => React.ReactNode
> = {
	"color-wheels": ColorWheelsControl,
};

export function getEffectControl({
	effectType,
}: {
	effectType: string;
}): ((props: EffectControlProps) => React.ReactNode) | null {
	return EFFECT_CONTROLS[effectType] ?? null;
}
