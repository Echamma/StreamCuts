import * as wasm from "opencut-wasm";
import type { ScopeSample } from "./scope-math";

interface PreparedRgbParade {
	readonly counts: Uint32Array;
	readonly columns: number;
	readonly bins: number;
	readonly peak: number;
	free(): void;
}

interface PreparedVectorscope {
	readonly counts: Uint32Array;
	readonly size: number;
	readonly peak: number;
	free(): void;
}

interface ScopeBindings {
	computeRgbParade(
		pixels: Uint8Array,
		width: number,
		height: number,
		columns: number,
		bins: number,
	): PreparedRgbParade;
	computeVectorscope(
		pixels: Uint8Array,
		width: number,
		height: number,
		size: number,
	): PreparedVectorscope;
}

// The scoped WASM binding is supplied by the Phase 3 package release. Keep
// the adapter narrow: all binning and color conversion remains in Rust.
const bindings = wasm as unknown as ScopeBindings;

function rgbaBytes(sample: ScopeSample): Uint8Array {
	return new Uint8Array(
		sample.pixels.buffer,
		sample.pixels.byteOffset,
		sample.pixels.byteLength,
	);
}

export function computeRgbParade({
	sample,
	columns,
	bins,
}: {
	sample: ScopeSample;
	columns: number;
	bins: number;
}): { counts: Uint32Array; columns: number; bins: number; peak: number } {
	const prepared = bindings.computeRgbParade(
		rgbaBytes(sample),
		sample.width,
		sample.height,
		columns,
		bins,
	);
	try {
		return {
			counts: prepared.counts,
			columns: prepared.columns,
			bins: prepared.bins,
			peak: prepared.peak,
		};
	} finally {
		prepared.free();
	}
}

export function computeVectorscope({
	sample,
	size,
}: {
	sample: ScopeSample;
	size: number;
}): { counts: Uint32Array; size: number; peak: number } {
	const prepared = bindings.computeVectorscope(
		rgbaBytes(sample),
		sample.width,
		sample.height,
		size,
	);
	try {
		return {
			counts: prepared.counts,
			size: prepared.size,
			peak: prepared.peak,
		};
	} finally {
		prepared.free();
	}
}
