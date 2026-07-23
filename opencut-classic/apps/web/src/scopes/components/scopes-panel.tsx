"use client";

import { useCallback, type RefObject } from "react";
import { useScopeSampler } from "@/scopes/use-scope-sampler";
import { WaveformWidget } from "./waveform-widget";
import { HistogramWidget } from "./histogram-widget";

/**
 * COL-009 P1 slice: waveform + histogram panel, floating over the preview's
 * top-right corner. Toggled via the "Scopes" entry in the preview context
 * menu (registered as a `PreviewOverlayDefinition`). The panel opts out of
 * pointer events so it never blocks canvas interaction.
 */
export function ScopesPanel({
	sourceCanvasContainerRef,
	isVisible,
}: {
	sourceCanvasContainerRef: RefObject<HTMLDivElement | null>;
	isVisible: boolean;
}) {
	const getSourceCanvas = useCallback((): HTMLCanvasElement | null => {
		return (
			sourceCanvasContainerRef.current?.querySelector("canvas") ?? null
		);
	}, [sourceCanvasContainerRef]);

	const sample = useScopeSampler({
		enabled: isVisible,
		getSourceCanvas,
	});

	if (!isVisible) return null;

	return (
		<div
			className="pointer-events-none absolute right-3 top-3 flex flex-col gap-2 rounded-md p-2"
			style={{
				background: "var(--scope-bg)",
				border: "1px solid var(--scope-graticule)",
			}}
		>
			<WaveformWidget sample={sample} />
			<HistogramWidget sample={sample} />
		</div>
	);
}
