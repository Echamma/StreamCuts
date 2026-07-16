/**
 * Pure level-metering math (FAIR-007). Given a block of time-domain samples
 * (e.g. from an `AnalyserNode.getFloatTimeDomainData`), compute peak/RMS and map
 * them to dBFS and to a 0..1 meter fill fraction, plus a peak-hold decay step.
 * No Web Audio or wasm dependency — the live wiring lives in the AudioManager,
 * this module is just arithmetic so it can be unit-tested headlessly.
 */

/** Bottom of the meter scale in dBFS; anything quieter reads as empty. */
export const METER_FLOOR_DB = -60;

export interface MeterLevels {
	/** Absolute peak sample magnitude in the block (linear, ~0..1+). */
	peak: number;
	/** Root-mean-square of the block (linear). */
	rms: number;
}

export function computeLevelsFromSamples({
	samples,
}: {
	samples: Float32Array;
}): MeterLevels {
	if (samples.length === 0) {
		return { peak: 0, rms: 0 };
	}

	let peak = 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index++) {
		const value = samples[index];
		const magnitude = value < 0 ? -value : value;
		if (magnitude > peak) {
			peak = magnitude;
		}
		sumSquares += value * value;
	}

	return { peak, rms: Math.sqrt(sumSquares / samples.length) };
}

/** Linear amplitude → dBFS. `<= 0` is silence, reported as `-Infinity`. */
export function linearToDbfs({ value }: { value: number }): number {
	if (value <= 0) {
		return -Infinity;
	}
	return 20 * Math.log10(value);
}

/**
 * Map a dBFS reading to a 0..1 meter fill fraction over `[floorDb, 0]`:
 * `0 dBFS` (and hotter) fills to 1, `floorDb` (and quieter, incl. `-Infinity`)
 * to 0. `NaN` guards to 0.
 */
export function dbfsToFraction({
	dbfs,
	floorDb = METER_FLOOR_DB,
}: {
	dbfs: number;
	floorDb?: number;
}): number {
	if (Number.isNaN(dbfs)) {
		return 0;
	}
	if (dbfs >= 0) {
		return 1;
	}
	if (dbfs <= floorDb) {
		return 0;
	}
	return (dbfs - floorDb) / -floorDb;
}

/** Convenience: linear amplitude → 0..1 meter fill fraction. */
export function linearToFraction({
	value,
	floorDb = METER_FLOOR_DB,
}: {
	value: number;
	floorDb?: number;
}): number {
	return dbfsToFraction({ dbfs: linearToDbfs({ value }), floorDb });
}

/**
 * One peak-hold step. `held` is the currently-held fraction, `current` the new
 * reading; the hold snaps up instantly to a louder reading and otherwise decays
 * toward `current` by `decay`, never dropping below it. All values in 0..1.
 */
export function decayPeakHold({
	held,
	current,
	decay,
}: {
	held: number;
	current: number;
	decay: number;
}): number {
	if (current >= held) {
		return current;
	}
	const next = held - decay;
	return next > current ? next : current;
}
