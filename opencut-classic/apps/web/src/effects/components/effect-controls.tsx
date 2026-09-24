import type { ParamValue, ParamValues } from "@/params";
import { ColorWheelsControl } from "./color-wheels-control";
import { LutControl } from "./lut-control";
import { CurvesControl, HslCurvesControl } from "./curves-control";

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
export function hasEffectControl(effectType: string): boolean {
	return (
		effectType === "color-wheels" ||
		effectType === "lut" ||
		effectType === "curves" ||
		effectType === "hsl-curves"
	);
}

export function EffectCustomControl({
	effectType,
	...props
}: EffectControlProps & { effectType: string }) {
	switch (effectType) {
		case "color-wheels":
			return <ColorWheelsControl {...props} />;
		case "lut":
			return <LutControl {...props} />;
		case "curves":
			return <CurvesControl {...props} />;
		case "hsl-curves":
			return <HslCurvesControl {...props} />;
		default:
			return null;
	}
}
