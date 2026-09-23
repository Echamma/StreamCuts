import type { EffectDefinition } from "@/effects/types";
import { prepareExactCurves } from "../curves/prepared-curves";
import { IDENTITY_CURVES } from "../luts/prepared-lut";

export const curvesEffectDefinition: EffectDefinition = {
	type: "curves",
	name: "Curves",
	keywords: ["color", "curve", "rgb", "contrast", "grade"],
	params: [
		{
			key: "curves",
			label: "Curves",
			type: "text",
			default: IDENTITY_CURVES,
			keyframable: false,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => {
			const source =
				typeof effectParams.curves === "string"
					? effectParams.curves
					: IDENTITY_CURVES;
			if (source === IDENTITY_CURVES) return [];
			const prepared = prepareExactCurves(source);
			if (!prepared.value || prepared.value.identity) return [];
			return [{ shader: "tone-curves", uniforms: prepared.value.uniforms }];
		},
	},
};
