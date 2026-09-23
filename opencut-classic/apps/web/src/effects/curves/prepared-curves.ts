import { prepareToneCurvesExact } from "opencut-wasm";
import type { EffectPass } from "@/effects/types";
import { readCurvePoints } from "../luts/prepared-lut";

type Prepared = { uniforms: EffectPass["uniforms"]; identity: boolean };
export type CurvesPreparation =
	| { value: Prepared; error?: never }
	| { error: string; value?: never };

// Content-addressed so duplicated clips share work; bounded because a drag can
// produce many successive versions of the same curve.
const cache = new Map<string, CurvesPreparation>();

export function prepareExactCurves(source: string): CurvesPreparation {
	const cached = cache.get(source);
	if (cached) {
		cache.delete(source);
		cache.set(source, cached);
		return cached;
	}

	let result: CurvesPreparation;
	try {
		const prepared = prepareToneCurvesExact(readCurvePoints(source));
		try {
			result = {
				value: {
					identity: prepared.identity,
					uniforms: {
						curveCounts: Array.from(prepared.counts),
						curveNodes: Array.from(prepared.nodes),
					},
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
