"use client";

import { useEffect, useRef } from "react";
import type { ScopeSample } from "@/scopes/scope-math";
import { computeRgbParade } from "@/scopes/scope-reductions";
import { readCssVarRgb } from "./css-color";

const CHANNEL_WIDTH = 86;
const WIDTH = CHANNEL_WIDTH * 3;
const HEIGHT = 192;

export function RgbParadeWidget({ sample }: { sample: ScopeSample | null }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;

		const image = ctx.createImageData(WIDTH, HEIGHT);
		if (sample) {
			const { counts, peak } = computeRgbParade({
				sample,
				columns: CHANNEL_WIDTH,
				bins: HEIGHT,
			});
			if (peak > 0) {
				const colors = [
					readCssVarRgb({
						element: canvas,
						variable: "--scope-trace-r",
						fallback: [232, 76, 76],
					}),
					readCssVarRgb({
						element: canvas,
						variable: "--scope-trace-g",
						fallback: [72, 199, 116],
					}),
					readCssVarRgb({
						element: canvas,
						variable: "--scope-trace-b",
						fallback: [83, 148, 246],
					}),
				];
				for (let channel = 0; channel < 3; channel++) {
					const color = colors[channel]!;
					for (let x = 0; x < CHANNEL_WIDTH; x++) {
						for (let bin = 0; bin < HEIGHT; bin++) {
							const count =
								counts[channel * CHANNEL_WIDTH * HEIGHT + x * HEIGHT + bin]!;
							if (count === 0) continue;
							const px = channel * CHANNEL_WIDTH + x;
							const py = HEIGHT - 1 - bin;
							const index = (py * WIDTH + px) * 4;
							image.data[index] = color[0];
							image.data[index + 1] = color[1];
							image.data[index + 2] = color[2];
							image.data[index + 3] = Math.round(Math.sqrt(count / peak) * 255);
						}
					}
				}
			}
		}
		ctx.putImageData(image, 0, 0);

		const graticule =
			getComputedStyle(canvas).getPropertyValue("--scope-graticule").trim() ||
			"hsl(220 8% 28%)";
		ctx.strokeStyle = graticule;
		ctx.lineWidth = 1;
		for (let i = 1; i < 4; i++) {
			const y = Math.round((i / 4) * HEIGHT) + 0.5;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(WIDTH, y);
			ctx.stroke();
		}
		for (let channel = 1; channel < 3; channel++) {
			const x = channel * CHANNEL_WIDTH + 0.5;
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, HEIGHT);
			ctx.stroke();
		}
		ctx.font = "10px sans-serif";
		for (let channel = 0; channel < 3; channel++) {
			ctx.fillStyle = ["#ed6666", "#5ed183", "#639fff"][channel]!;
			ctx.fillText(["R", "G", "B"][channel]!, channel * CHANNEL_WIDTH + 7, 14);
		}
	}, [sample]);

	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-[10px] uppercase tracking-wide">
				RGB parade
			</span>
			<canvas
				ref={canvasRef}
				width={WIDTH}
				height={HEIGHT}
				role="img"
				aria-label="RGB parade"
				className="border-border/40 rounded border"
				style={{ width: WIDTH, height: HEIGHT, background: "var(--scope-bg)" }}
			/>
		</div>
	);
}
