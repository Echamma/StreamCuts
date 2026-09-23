import type { EffectDefinition } from "@/effects/types";
import { lutPasses, prepareLut } from "../luts/prepared-lut";

export const lutEffectDefinition: EffectDefinition = {
	type: "lut",
	name: "Color LUT",
	keywords: ["color", "lut", "cube", "grade"],
	params: [
		{
			key: "cube",
			label: "LUT file",
			type: "text",
			default: "",
			keyframable: false,
		},
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 1,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => {
			const source =
				typeof effectParams.cube === "string" ? effectParams.cube : "";
			const intensity =
				typeof effectParams.intensity === "number" ? effectParams.intensity : 1;
			if (!source || intensity <= 0) return [];
			return lutPasses({
				prepared: prepareLut({ kind: "cube", source }),
				intensity,
			});
		},
	},
};
