import type { EffectDefinition } from "@/effects/types";
import {
	IDENTITY_HSL_CURVES,
	prepareHslCurvePass,
} from "../curves/prepared-hsl-curves";

export const hslCurvesEffectDefinition: EffectDefinition = {
	type: "hsl-curves",
	name: "HSL Curves",
	keywords: ["color", "hue", "saturation", "lightness", "curves"],
	params: [
		{
			key: "hslCurves",
			label: "HSL Curves",
			type: "text",
			default: IDENTITY_HSL_CURVES,
			keyframable: false,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => {
			const source =
				typeof effectParams.hslCurves === "string"
					? effectParams.hslCurves
					: IDENTITY_HSL_CURVES;
			if (source === IDENTITY_HSL_CURVES) return [];
			const prepared = prepareHslCurvePass(source);
			if (!prepared.value || prepared.value.identity) return [];
			return [{ shader: "hsl-curves", uniforms: prepared.value.uniforms }];
		},
	},
};
