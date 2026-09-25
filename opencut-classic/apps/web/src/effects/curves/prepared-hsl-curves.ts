import { prepareHslCurves } from "opencut-wasm";
import type { EffectPass } from "@/effects/types";
import { readCurvePoints } from "../luts/prepared-lut";

export const IDENTITY_HSL_CURVES =
	"[[[0,0.5],[1,0.5]],[[0,0.5],[1,0.5]],[[0,0.5],[1,0.5]],[[0,0.5],[1,0.5]]]";

type Preparation =
	| {
			value: { uniforms: EffectPass["uniforms"]; identity: boolean };
			error?: never;
	  }
	| { error: string; value?: never };

const cache = new Map<string, Preparation>();

export function prepareHslCurvePass(source: string): Preparation {
	const cached = cache.get(source);
	if (cached) {
		cache.delete(source);
		cache.set(source, cached);
		return cached;
	}
	let result: Preparation;
	try {
		const prepared = prepareHslCurves(readCurvePoints(source));
		try {
			result = {
				value: {
					identity: prepared.identity,
					uniforms: { curveTable: Array.from(prepared.table) },
				},
			};
		} finally {
			prepared.free();
		}
	} catch (error) {
		result = { error: error instanceof Error ? error.message : String(error) };
	}
	if (cache.size >= 8) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(source, result);
	return result;
}
