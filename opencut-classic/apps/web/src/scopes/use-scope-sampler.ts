"use client";

import { useEffect, useRef, useState } from "react";
import type { ScopeSample } from "./scope-math";

const DEFAULT_SAMPLE_WIDTH = 480;
const DEFAULT_SAMPLE_HEIGHT = 270;

/**
 * CPU tap for COL-009 scopes: while `enabled`, each animation frame we
 * `drawImage` the source canvas into a persistent ~480×270 2D scratch canvas
 * and hand back the resulting `ImageData.data`.
 *
 * Consumers pass a getter (`getSourceCanvas`) rather than a ref value so the
 * hook can re-read the wgpu output canvas per frame — its identity is stable
 * across renders but its buffer is redrawn on every render tree pass.
 *
 * The WebGPU-native compute path (WGSL reductions) is the follow-on for scope
 * palette parity per docs/roadmap/40 §2; this fallback works everywhere.
 */
export function useScopeSampler({
	enabled,
	getSourceCanvas,
	sampleWidth = DEFAULT_SAMPLE_WIDTH,
	sampleHeight = DEFAULT_SAMPLE_HEIGHT,
}: {
	enabled: boolean;
	getSourceCanvas: () => HTMLCanvasElement | null;
	sampleWidth?: number;
	sampleHeight?: number;
}): ScopeSample | null {
	const [sample, setSample] = useState<ScopeSample | null>(null);
	const scratchRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		// When disabled we simply don't run the sampler; consumers gate on the
		// same flag and won't render a stale frame, so there's no need to reset
		// state synchronously here (which React discourages inside effects).
		if (!enabled) return;

		if (!scratchRef.current) {
			scratchRef.current = document.createElement("canvas");
		}
		const scratch = scratchRef.current;
		scratch.width = sampleWidth;
		scratch.height = sampleHeight;
		const ctx = scratch.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;

		let rafId = 0;
		let disposed = false;

		const tick = () => {
			if (disposed) return;
			const source = getSourceCanvas();
			if (source && source.width > 0 && source.height > 0) {
				try {
					ctx.drawImage(source, 0, 0, sampleWidth, sampleHeight);
					const data = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
					setSample({
						pixels: data.data,
						width: sampleWidth,
						height: sampleHeight,
					});
				} catch {
					// Cross-origin taint or a mid-resize race: skip this frame.
				}
			}
			rafId = requestAnimationFrame(tick);
		};

		rafId = requestAnimationFrame(tick);
		return () => {
			disposed = true;
			cancelAnimationFrame(rafId);
		};
	}, [enabled, getSourceCanvas, sampleWidth, sampleHeight]);

	return enabled ? sample : null;
}
