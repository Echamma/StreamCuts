"use client";

import { useEffect, useRef } from "react";
import { computeHistogram } from "@/scopes/scope-math";
import type { ScopeSample } from "@/scopes/scope-math";
import { readCssVarRgb } from "./css-color";

const WIDTH = 256;
const HEIGHT = 128;

interface Trace {
	values: Uint32Array;
	rgb: [number, number, number];
}

/**
 * RGB + luma histogram (COL-009 P1 slice): 256-bin count per channel, all four
 * traces sharing the same y-normalisation so relative distribution is
 * directly comparable at a glance.
 */
export function HistogramWidget({ sample }: { sample: ScopeSample | null }) {
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
		for (let i = 1; i < 4; i++) {
			const x = Math.round((i / 4) * (WIDTH - 1)) + 0.5;
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, HEIGHT);
			ctx.stroke();
		}

		if (!sample) return;

		const { red, green, blue, luma, peak } = computeHistogram({ sample });
		if (peak === 0) return;

		const traces: Trace[] = [
			{ values: luma, rgb: readCssVarRgb({ element: canvas, variable: "--scope-trace-luma", fallback: [210, 210, 210] }) },
			{ values: red, rgb: readCssVarRgb({ element: canvas, variable: "--scope-trace-r", fallback: [232, 76, 76] }) },
			{ values: green, rgb: readCssVarRgb({ element: canvas, variable: "--scope-trace-g", fallback: [72, 199, 116] }) },
			{ values: blue, rgb: readCssVarRgb({ element: canvas, variable: "--scope-trace-b", fallback: [83, 148, 246] }) },
		];

		// Additive traces so overlaps read as brighter, matching how a scope
		// display blends beam intensity.
		ctx.globalCompositeOperation = "lighter";
		for (const trace of traces) {
			ctx.fillStyle = `rgba(${trace.rgb[0]}, ${trace.rgb[1]}, ${trace.rgb[2]}, 0.55)`;
			ctx.beginPath();
			ctx.moveTo(0, HEIGHT);
			for (let bin = 0; bin < 256; bin++) {
				const count = trace.values[bin]!;
				const y = HEIGHT - Math.min(HEIGHT, (count / peak) * HEIGHT);
				const x = (bin / 255) * WIDTH;
				ctx.lineTo(x, y);
			}
			ctx.lineTo(WIDTH, HEIGHT);
			ctx.closePath();
			ctx.fill();
		}
		ctx.globalCompositeOperation = "source-over";
	}, [sample]);

	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-[10px] uppercase tracking-wide">
				Histogram
			</span>
			<canvas
				ref={canvasRef}
				className="border-border/40 rounded border"
				style={{ width: WIDTH, height: HEIGHT, background: "var(--scope-bg)" }}
			/>
		</div>
	);
}
