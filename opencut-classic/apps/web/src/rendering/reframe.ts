import type { ParamValues } from "@/params";

export interface Reframe {
	x: number;
	y: number;
	scale: number;
}

/** The neutral reframe state. Source frames render unchanged at identity, so
 * the compositor short-circuits to its legacy contain-fit path. Kept here with
 * no animation dependency so callers (and unit tests) can use the pure helpers
 * without dragging in the keyframe resolver. */
export const REFRAME_IDENTITY: Reframe = {
	x: 0.5,
	y: 0.5,
	scale: 1,
};

export function isReframeIdentity(reframe: Reframe): boolean {
	return (
		reframe.x === REFRAME_IDENTITY.x &&
		reframe.y === REFRAME_IDENTITY.y &&
		reframe.scale === REFRAME_IDENTITY.scale
	);
}

export function readReframeFromParams({
	params,
}: {
	params: ParamValues;
}): Reframe {
	return {
		x: readNumberParam({ params, key: "reframe.x", fallback: REFRAME_IDENTITY.x }),
		y: readNumberParam({ params, key: "reframe.y", fallback: REFRAME_IDENTITY.y }),
		scale: readNumberParam({
			params,
			key: "reframe.scale",
			fallback: REFRAME_IDENTITY.scale,
		}),
	};
}

function readNumberParam({
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
