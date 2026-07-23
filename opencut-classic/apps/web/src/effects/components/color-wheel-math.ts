/**
 * Trackball geometry for the color-wheels control (COL-002 UI).
 *
 * A wheel is a draggable point in a unit disc. Red/Green/Blue sit 120° apart
 * (red up, following a standard color wheel); the drag vector projects onto
 * each primary direction to give a zero-sum RGB *balance* (a hue push that
 * doesn't change overall level — that's what the separate master control is
 * for). The map is invertible on that zero-sum subspace, so a stored balance
 * round-trips back to a dot position for rendering.
 */

export interface Vec2 {
	x: number;
	y: number;
}

export interface RgbBalance {
	r: number;
	g: number;
	b: number;
}

// Unit direction of each primary on the disc: R at 90° (up), G at 210°, B at 330°.
// These sum to zero, which is what makes a pad drag a pure (level-preserving) push.
const DIR = {
	r: { x: Math.cos((90 * Math.PI) / 180), y: Math.sin((90 * Math.PI) / 180) },
	g: { x: Math.cos((210 * Math.PI) / 180), y: Math.sin((210 * Math.PI) / 180) },
	b: { x: Math.cos((330 * Math.PI) / 180), y: Math.sin((330 * Math.PI) / 180) },
};

/** Clamp a point into the unit disc (radius ≤ 1). */
export function clampToDisc({ point }: { point: Vec2 }): Vec2 {
	const radius = Math.hypot(point.x, point.y);
	if (radius <= 1) return point;
	return { x: point.x / radius, y: point.y / radius };
}

/**
 * Pad position (unit disc) → RGB balance, scaled by `amount` (the balance a
 * primary reaches at full radius). Dragging toward red boosts red and lowers
 * green/blue by half each (sum stays ~0).
 */
export function padToBalance({
	point,
	amount,
}: {
	point: Vec2;
	amount: number;
}): RgbBalance {
	const p = clampToDisc({ point });
	return {
		r: amount * (p.x * DIR.r.x + p.y * DIR.r.y),
		g: amount * (p.x * DIR.g.x + p.y * DIR.g.y),
		b: amount * (p.x * DIR.b.x + p.y * DIR.b.y),
	};
}

/**
 * RGB balance → pad position (inverse of {@link padToBalance}). Uses the closed
 * form `(2/3) Σ dir_c · b_c / amount` — exact on the zero-sum subspace the pad
 * produces, and a sensible least-squares projection otherwise.
 */
export function balanceToPad({
	balance,
	amount,
}: {
	balance: RgbBalance;
	amount: number;
}): Vec2 {
	if (amount === 0) return { x: 0, y: 0 };
	const x =
		((2 / 3) *
			(DIR.r.x * balance.r + DIR.g.x * balance.g + DIR.b.x * balance.b)) /
		amount;
	const y =
		((2 / 3) *
			(DIR.r.y * balance.r + DIR.g.y * balance.g + DIR.b.y * balance.b)) /
		amount;
	return clampToDisc({ point: { x, y } });
}
