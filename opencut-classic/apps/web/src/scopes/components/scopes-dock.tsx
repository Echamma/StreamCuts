"use client";

import { useCallback } from "react";
import { useScopeSampler } from "@/scopes/use-scope-sampler";
import { WaveformWidget } from "./waveform-widget";
import { HistogramWidget } from "./histogram-widget";

/**
 * Always-on scopes dock for the Color page. Unlike the preview's toggleable
 * scopes overlay, this is a persistent panel; it finds the wgpu output canvas
 * by the stable `[data-scope-source]` marker on the preview mount (the same CPU
 * tap, sourced by a DOM query since the dock lives outside the preview subtree).
 */
export function ScopesDock() {
	const getSourceCanvas = useCallback((): HTMLCanvasElement | null => {
		return document.querySelector<HTMLCanvasElement>(
			"[data-scope-source] canvas",
		);
	}, []);

	const sample = useScopeSampler({ enabled: true, getSourceCanvas });

	return (
		<div
			className="flex h-full flex-col gap-3 overflow-auto p-3"
			style={{ background: "var(--scope-bg)" }}
		>
			<span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
				Scopes
			</span>
			<WaveformWidget sample={sample} />
			<HistogramWidget sample={sample} />
		</div>
	);
}
