"use client";

import { useEffect, useRef } from "react";
import type { ScopeSample } from "@/scopes/scope-math";
import { computeVectorscope } from "@/scopes/scope-reductions";

const SIZE = 256;

// Rec.709 100% color-bar positions in normalized Cb/Cr display space.
const TARGETS = [
	{ label: "R", x: 0.3854, y: 0, color: "#ed6666" },
	{ label: "G", x: 0.1146, y: 0.9542, color: "#5ed183" },
	{ label: "B", x: 1, y: 0.5458, color: "#639fff" },
	{ label: "C", x: 0.6146, y: 1, color: "#67d6d6" },
	{ label: "M", x: 0.8854, y: 0.0458, color: "#d77ed7" },
	{ label: "Y", x: 0, y: 0.4542, color: "#ded66f" },
] as const;

export function VectorscopeWidget({ sample }: { sample: ScopeSample | null }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;

		const image = ctx.createImageData(SIZE, SIZE);
		if (sample) {
			const { counts, peak } = computeVectorscope({ sample, size: SIZE });
			if (peak > 0) {
				for (let i = 0; i < counts.length; i++) {
					const count = counts[i]!;
					if (count === 0) continue;
					const index = i * 4;
					image.data[index] = 225;
					image.data[index + 1] = 235;
					image.data[index + 2] = 225;
					image.data[index + 3] = Math.round(Math.sqrt(count / peak) * 255);
				}
			}
		}
		ctx.putImageData(image, 0, 0);

		const graticule =
			getComputedStyle(canvas).getPropertyValue("--scope-graticule").trim() ||
			"hsl(220 8% 28%)";
		ctx.strokeStyle = graticule;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(SIZE / 2 + 0.5, 0);
		ctx.lineTo(SIZE / 2 + 0.5, SIZE);
		ctx.moveTo(0, SIZE / 2 + 0.5);
		ctx.lineTo(SIZE, SIZE / 2 + 0.5);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.4, 0, Math.PI * 2);
		ctx.stroke();
		ctx.font = "10px sans-serif";
		for (const target of TARGETS) {
			const x = target.x * (SIZE - 1);
			const y = target.y * (SIZE - 1);
			ctx.strokeStyle = target.color;
			ctx.strokeRect(
				Math.max(1, Math.min(SIZE - 9, x - 4)),
				Math.max(1, Math.min(SIZE - 9, y - 4)),
				8,
				8,
			);
			ctx.fillStyle = target.color;
			ctx.fillText(
				target.label,
				Math.max(3, Math.min(SIZE - 12, x + 7)),
				Math.max(11, Math.min(SIZE - 3, y + 4)),
			);
		}
	}, [sample]);

	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-[10px] uppercase tracking-wide">
				Vectorscope
			</span>
			<canvas
				ref={canvasRef}
				width={SIZE}
				height={SIZE}
				role="img"
				aria-label="Vectorscope"
				className="border-border/40 rounded border"
				style={{ width: SIZE, height: SIZE, background: "var(--scope-bg)" }}
			/>
		</div>
	);
}
