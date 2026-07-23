import type {
	EffectDefinition,
	EffectPass,
	EffectUniformValue,
} from "@/effects/types";
import type { ParamValues } from "@/params";

export const COLOR_WHEELS_SHADER = "color-wheels";

/** One trackball: an RGB balance plus a master (luma) offset. */
interface WheelValues {
	r: number;
	g: number;
	b: number;
	master: number;
}

interface ColorGradeValues {
	lift: WheelValues;
	gamma: WheelValues;
	gain: WheelValues;
	offset: WheelValues;
	contrast: number;
	pivot: number;
	saturation: number;
	temperature: number;
	tint: number;
	hue: number;
}

const LIFT_DEFAULT: WheelValues = { r: 0, g: 0, b: 0, master: 0 };
const GAMMA_DEFAULT: WheelValues = { r: 1, g: 1, b: 1, master: 0 };
const GAIN_DEFAULT: WheelValues = { r: 1, g: 1, b: 1, master: 0 };
const OFFSET_DEFAULT: WheelValues = { r: 0, g: 0, b: 0, master: 0 };

function num({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	return typeof value === "number" ? value : fallback;
}

function readWheel({
	params,
	prefix,
	fallback,
}: {
	params: ParamValues;
	prefix: string;
	fallback: WheelValues;
}): WheelValues {
	return {
		r: num({ params, key: `${prefix}_r`, fallback: fallback.r }),
		g: num({ params, key: `${prefix}_g`, fallback: fallback.g }),
		b: num({ params, key: `${prefix}_b`, fallback: fallback.b }),
		master: num({ params, key: `${prefix}_master`, fallback: fallback.master }),
	};
}

export function readColorGradeParams(params: ParamValues): ColorGradeValues {
	return {
		lift: readWheel({ params, prefix: "lift", fallback: LIFT_DEFAULT }),
		gamma: readWheel({ params, prefix: "gamma", fallback: GAMMA_DEFAULT }),
		gain: readWheel({ params, prefix: "gain", fallback: GAIN_DEFAULT }),
		offset: readWheel({ params, prefix: "offset", fallback: OFFSET_DEFAULT }),
		contrast: num({ params, key: "contrast", fallback: 1 }),
		pivot: num({ params, key: "pivot", fallback: 0.5 }),
		saturation: num({ params, key: "saturation", fallback: 1 }),
		temperature: num({ params, key: "temperature", fallback: 0 }),
		tint: num({ params, key: "tint", fallback: 0 }),
		hue: num({ params, key: "hue", fallback: 0 }),
	};
}

function wheelIsNeutral({
	wheel,
	neutral,
}: {
	wheel: WheelValues;
	neutral: WheelValues;
}): boolean {
	return (
		wheel.r === neutral.r &&
		wheel.g === neutral.g &&
		wheel.b === neutral.b &&
		wheel.master === neutral.master
	);
}

/**
 * True when the grade is a byte-exact no-op — every stage is at its neutral
 * value. `pivot` is ignored because it has no effect while `contrast === 1`.
 */
export function isIdentityColorGrade(values: ColorGradeValues): boolean {
	return (
		wheelIsNeutral({ wheel: values.lift, neutral: LIFT_DEFAULT }) &&
		wheelIsNeutral({ wheel: values.gamma, neutral: GAMMA_DEFAULT }) &&
		wheelIsNeutral({ wheel: values.gain, neutral: GAIN_DEFAULT }) &&
		wheelIsNeutral({ wheel: values.offset, neutral: OFFSET_DEFAULT }) &&
		values.contrast === 1 &&
		values.saturation === 1 &&
		values.temperature === 0 &&
		values.tint === 0 &&
		values.hue === 0
	);
}

export function colorGradeUniforms(
	values: ColorGradeValues,
): Record<string, EffectUniformValue> {
	return {
		u_lift: [values.lift.r, values.lift.g, values.lift.b],
		u_lift_master: values.lift.master,
		u_gamma: [values.gamma.r, values.gamma.g, values.gamma.b],
		u_gamma_master: values.gamma.master,
		u_gain: [values.gain.r, values.gain.g, values.gain.b],
		u_gain_master: values.gain.master,
		u_offset: [values.offset.r, values.offset.g, values.offset.b],
		u_offset_master: values.offset.master,
		u_contrast: values.contrast,
		u_pivot: values.pivot,
		u_saturation: values.saturation,
		u_temperature: values.temperature,
		u_tint: values.tint,
		u_hue: values.hue,
	};
}

/** Build the (0 or 1) passes for a grade — identity grades render nothing. */
export function buildColorWheelsPasses({
	effectParams,
}: {
	effectParams: ParamValues;
}): EffectPass[] {
	const values = readColorGradeParams(effectParams);
	if (isIdentityColorGrade(values)) {
		return [];
	}
	return [{ shader: COLOR_WHEELS_SHADER, uniforms: colorGradeUniforms(values) }];
}

function wheelParams({
	prefix,
	label,
	defaults,
	balanceRange,
}: {
	prefix: string;
	label: string;
	defaults: WheelValues;
	balanceRange: { min: number; max: number };
}): EffectDefinition["params"] {
	const channel = ({
		suffix,
		channelLabel,
	}: {
		suffix: "r" | "g" | "b";
		channelLabel: string;
	}) => ({
		key: `${prefix}_${suffix}`,
		label: `${label} ${channelLabel}`,
		type: "number" as const,
		default: defaults[suffix],
		min: balanceRange.min,
		max: balanceRange.max,
		step: 0.01,
	});
	return [
		channel({ suffix: "r", channelLabel: "R" }),
		channel({ suffix: "g", channelLabel: "G" }),
		channel({ suffix: "b", channelLabel: "B" }),
		{
			key: `${prefix}_master`,
			label: `${label} Master`,
			type: "number" as const,
			default: defaults.master,
			min: balanceRange.min,
			max: balanceRange.max,
			step: 0.01,
		},
	];
}

export const colorWheelsEffectDefinition: EffectDefinition = {
	type: "color-wheels",
	name: "Color Wheels",
	keywords: ["color", "grade", "wheels", "lift", "gamma", "gain", "primary"],
	params: [
		...wheelParams({ prefix: "lift", label: "Lift", defaults: LIFT_DEFAULT, balanceRange: { min: -0.5, max: 0.5 } }),
		...wheelParams({ prefix: "gamma", label: "Gamma", defaults: GAMMA_DEFAULT, balanceRange: { min: 0.1, max: 3 } }),
		...wheelParams({ prefix: "gain", label: "Gain", defaults: GAIN_DEFAULT, balanceRange: { min: 0, max: 3 } }),
		...wheelParams({ prefix: "offset", label: "Offset", defaults: OFFSET_DEFAULT, balanceRange: { min: -0.5, max: 0.5 } }),
		{ key: "contrast", label: "Contrast", type: "number", default: 1, min: 0, max: 2, step: 0.01 },
		{ key: "pivot", label: "Pivot", type: "number", default: 0.5, min: 0, max: 1, step: 0.01 },
		{ key: "saturation", label: "Saturation", type: "number", default: 1, min: 0, max: 2, step: 0.01 },
		{ key: "temperature", label: "Temperature", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "tint", label: "Tint", type: "number", default: 0, min: -1, max: 1, step: 0.01 },
		{ key: "hue", label: "Hue", type: "number", default: 0, min: -180, max: 180, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: COLOR_WHEELS_SHADER,
				uniforms: ({ effectParams }) =>
					colorGradeUniforms(readColorGradeParams(effectParams)),
			},
		],
		buildPasses: buildColorWheelsPasses,
	},
};
