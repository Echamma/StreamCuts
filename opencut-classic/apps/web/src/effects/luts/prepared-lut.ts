import {
	prepareCubeLut,
	prepareToneCurves,
	type PreparedColorLut,
} from "opencut-wasm";
import { z } from "zod";
import type { EffectPass } from "@/effects/types";

export const IDENTITY_CURVES =
	"[[[0,0],[1,1]],[[0,0],[1,1]],[[0,0],[1,1]],[[0,0],[1,1]]]";
const point = z.tuple([
	z.number().finite().min(0).max(1),
	z.number().finite().min(0).max(1),
]);
const curveSchema = z.array(z.array(point).min(2).max(32)).length(4);
export type CurvePoints = [number, number][];
export function readCurvePoints(value: string): CurvePoints[] {
	return curveSchema.parse(JSON.parse(value));
}

type Prepared = { uniforms: EffectPass["uniforms"]; identity: boolean };
export type LutPreparation =
	| { value: Prepared; error?: never }
	| { error: string; value?: never };
// Bounded by content, not clip id: duplicate clips share parsing/baking work.
// These arrays go straight into pass uniforms, never into a node content hash.
const caches = {
	cube: new Map<string, LutPreparation>(),
	curves: new Map<string, LutPreparation>(),
};

export function prepareLut({
	kind,
	source,
}: {
	kind: "cube" | "curves";
	source: string;
}): LutPreparation {
	const cache = caches[kind];
	const key = source;
	const cached = cache.get(key);
	if (cached) {
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}
	let result: LutPreparation;
	try {
		const lut: PreparedColorLut =
			kind === "cube"
				? prepareCubeLut(source)
				: prepareToneCurves(readCurvePoints(source));
		try {
			result = {
				value: {
					identity: lut.identity,
					uniforms: {
						lutSize: lut.size,
						lutTable: Array.from(lut.table),
						domainMin: Array.from(lut.domainMin),
						domainMax: Array.from(lut.domainMax),
					},
				},
			};
		} finally {
			lut.free();
		}
	} catch (error) {
		result = { error: error instanceof Error ? error.message : String(error) };
	}
	if (cache.size >= 8) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, result);
	return result;
}

export function lutPasses({
	prepared,
	intensity,
}: {
	prepared: LutPreparation;
	intensity: number;
}): EffectPass[] {
	if (
		!prepared.value ||
		prepared.value.identity ||
		!Number.isFinite(intensity) ||
		intensity <= 0
	)
		return [];
	return [
		{
			shader: "lut-3d",
			uniforms: {
				...prepared.value.uniforms,
				intensity: Math.min(1, intensity),
			},
		},
	];
}
