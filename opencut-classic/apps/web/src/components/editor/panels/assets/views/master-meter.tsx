"use client";

import { useEffect, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { decayPeakHold, linearToFraction } from "@/media/audio-metering";

// Meter zone colors (saturated, so they read on both light and dark themes).
const METER_GREEN = "#22c55e";
const METER_YELLOW = "#eab308";
const METER_RED = "#ef4444";
const YELLOW_AT = 0.7;
const RED_AT = 0.85;
// Peak-hold falls this much of the full scale per animation frame (~0.6/s @60fps).
const PEAK_DECAY_PER_FRAME = 0.01;

function zoneColor(fraction: number): string {
	if (fraction >= RED_AT) return METER_RED;
	if (fraction >= YELLOW_AT) return METER_YELLOW;
	return METER_GREEN;
}

/**
 * FAIR-007 master output meter. Polls the AudioManager's post-limiter analyser
 * each animation frame and draws an RMS fill with a decaying peak-hold marker.
 * The loop runs only while this component is mounted (i.e. the Audio mixer is
 * open), and reads zeros — decaying to empty — when nothing is playing.
 */
export function MasterMeter() {
	const editor = useEditor();
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		let frame = 0;
		let peakHold = 0;

		const draw = () => {
			const levels = editor.audio.readMasterMeter();
			const rmsFraction = levels
				? linearToFraction({ value: levels.rms })
				: 0;
			const peakFraction = levels
				? linearToFraction({ value: levels.peak })
				: 0;
			peakHold = decayPeakHold({
				held: peakHold,
				current: peakFraction,
				decay: PEAK_DECAY_PER_FRAME,
			});

			const dpr = window.devicePixelRatio || 1;
			const targetWidth = Math.round(canvas.clientWidth * dpr);
			const targetHeight = Math.round(canvas.clientHeight * dpr);
			if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
				canvas.width = targetWidth;
				canvas.height = targetHeight;
			}
			const width = canvas.width;
			const height = canvas.height;

			ctx.clearRect(0, 0, width, height);
			ctx.fillStyle = "rgba(128, 128, 128, 0.15)";
			ctx.fillRect(0, 0, width, height);

			if (rmsFraction > 0) {
				const gradient = ctx.createLinearGradient(0, 0, width, 0);
				gradient.addColorStop(0, METER_GREEN);
				gradient.addColorStop(YELLOW_AT, METER_GREEN);
				gradient.addColorStop(RED_AT, METER_YELLOW);
				gradient.addColorStop(1, METER_RED);
				ctx.fillStyle = gradient;
				ctx.fillRect(0, 0, width * rmsFraction, height);
			}

			if (peakHold > 0) {
				const markerWidth = Math.max(2, Math.round(dpr));
				const x = Math.min(
					width - markerWidth,
					Math.max(0, width * peakHold - markerWidth / 2),
				);
				ctx.fillStyle = zoneColor(peakHold);
				ctx.fillRect(x, 0, markerWidth, height);
			}

			frame = requestAnimationFrame(draw);
		};

		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, [editor]);

	// Decorative: the level is a fast-moving visual, not content for assistive
	// tech (there's no meaningful static value to expose), so hide it from AT.
	return (
		<canvas
			ref={canvasRef}
			className="h-2.5 w-full rounded-full"
			aria-hidden="true"
		/>
	);
}
