"use client";

import { useEffect, useRef } from "react";
import { computeWaveform } from "@/scopes/scope-math";
import type { ScopeSample } from "@/scopes/scope-math";
import { readCssVarRgb } from "./css-color";

const WIDTH = 256;
const HEIGHT = 192;
const LUMA_BINS = HEIGHT;

/**
 * Luma waveform (COL-009 P1 slice): each column shows the vertical spread of
 * luma values found in the matching x-strip of the source frame. Brighter cells
 * = more pixels at that (x, luma) location.
 */
export function WaveformWidget({ sample }: { sample: ScopeSample | null }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		if (canvas.width !== WIDTH * dpr || canvas.height !== HEIGHT * dpr) {
			canvas.width = WIDTH * dpr;
			canvas.height = HEIGHT * dpr;
			ctx.scale(dpr, dpr);
		}

		const bg = getComputedStyle(canvas).getPropertyValue("--scope-bg").trim();
		ctx.fillStyle = bg || "hsl(220, 10%, 8%)";
		ctx.fillRect(0, 0, WIDTH, HEIGHT);

		const graticule =
			getComputedStyle(canvas).getPropertyValue("--scope-graticule").trim() ||
			"hsl(220, 8%, 28%)";
		ctx.strokeStyle = graticule;
		ctx.lineWidth = 1;
		for (let i = 0; i <= 4; i++) {
			const y = Math.round((i / 4) * (HEIGHT - 1)) + 0.5;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(WIDTH, y);
			ctx.stroke();
		}

		if (!sample) return;

		const { counts, columns, lumaBins, peak } = computeWaveform({
			sample,
			columns: WIDTH,
			lumaBins: LUMA_BINS,
		});
		if (peak === 0) return;

		const trace = readCssVarRgb({
			element: canvas,
			variable: "--scope-trace-luma",
			fallback: [230, 230, 230],
		});
		const image = ctx.createImageData(WIDTH, HEIGHT);
		for (let x = 0; x < columns; x++) {
			for (let bin = 0; bin < lumaBins; bin++) {
				const count = counts[x * lumaBins + bin]!;
				if (count === 0) continue;
				const y = HEIGHT - 1 - bin; // top of canvas = white
				const idx = (y * WIDTH + x) * 4;
				const alpha = Math.min(1, Math.sqrt(count / peak));
				image.data[idx] = trace[0];
				image.data[idx + 1] = trace[1];
				image.data[idx + 2] = trace[2];
				image.data[idx + 3] = Math.round(alpha * 255);
			}
		}
		ctx.putImageData(image, 0, 0);
	}, [sample]);

	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-[10px] uppercase tracking-wide">
				Waveform
			</span>
			<canvas
				ref={canvasRef}
				className="border-border/40 rounded border"
				style={{ width: WIDTH, height: HEIGHT, background: "var(--scope-bg)" }}
			/>
		</div>
	);
}
