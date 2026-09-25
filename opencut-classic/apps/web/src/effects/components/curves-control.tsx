"use client";

import { useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { sampleHslCurve, sampleToneCurve } from "opencut-wasm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	IDENTITY_CURVES,
	readCurvePoints,
	type CurvePoints,
} from "../luts/prepared-lut";
import type { EffectControlProps } from "./effect-controls";
import { IDENTITY_HSL_CURVES } from "../curves/prepared-hsl-curves";

const CHANNELS = ["Master", "Red", "Green", "Blue"];
const COLORS = ["currentColor", "#f87171", "#4ade80", "#60a5fa"];
const HSL_CHANNELS = [
	"Hue vs Hue",
	"Hue vs Saturation",
	"Hue vs Lightness",
	"Lightness vs Saturation",
];
const HSL_COLORS = ["#f87171", "#4ade80", "#60a5fa", "#facc15"];

export function CurvesControl(props: EffectControlProps) {
	return <CurveGraphControl {...props} kind="tone" />;
}

export function HslCurvesControl(props: EffectControlProps) {
	return <CurveGraphControl {...props} kind="hsl" />;
}

function CurveGraphControl({
	values,
	previewParam,
	onCommit,
	kind,
}: EffectControlProps & { kind: "tone" | "hsl" }) {
	const isHsl = kind === "hsl";
	const paramKey = isHsl ? "hslCurves" : "curves";
	const identity = isHsl ? IDENTITY_HSL_CURVES : IDENTITY_CURVES;
	const channels = isHsl ? HSL_CHANNELS : CHANNELS;
	const colors = isHsl ? HSL_COLORS : COLORS;
	const [channel, setChannel] = useState(0);
	const [selected, setSelected] = useState(0);
	const [focusedPoint, setFocusedPoint] = useState<number | null>(null);
	const pointInstructionsId = useId();
	const gradientId = useId();
	const drag = useRef<number | null>(null);
	const svg = useRef<SVGSVGElement>(null);
	const source =
		typeof values[paramKey] === "string" ? values[paramKey] : identity;
	const parsed = useMemo(() => {
		try {
			return { curves: readCurvePoints(source), error: "" };
		} catch {
			return {
				curves: readCurvePoints(identity),
				error: "Invalid saved curve. Reset the curve to recover.",
			};
		}
	}, [source, identity]);
	const points = parsed.curves[channel];
	const pointIndex = Math.min(selected, points.length - 1);
	const drawing = useMemo(() => {
		try {
			return {
				samples: Array.from(
					isHsl ? sampleHslCurve(points, channel < 3) : sampleToneCurve(points),
				),
				error: "",
			};
		} catch (error) {
			return { samples: [], error: String(error) };
		}
	}, [points, channel, isHsl]);
	const error = parsed.error || drawing.error;
	function preview(next: CurvePoints) {
		previewParam(paramKey)(
			JSON.stringify(
				parsed.curves.map((curve, index) => (index === channel ? next : curve)),
			),
		);
	}
	function movePoint({ index, x, y }: { index: number; x: number; y: number }) {
		const low = index === 0 ? 0 : points[index - 1][0] + 0.001;
		const high = index === points.length - 1 ? 1 : points[index + 1][0] - 0.001;
		const nextX =
			index === 0
				? 0
				: index === points.length - 1
					? 1
					: Math.max(low, Math.min(high, x));
		const nextY = Math.max(0, Math.min(1, y));
		preview(
			points.map((point, i) => {
				if (i === index) return [nextX, nextY];
				if (
					isHsl &&
					channel < 3 &&
					((index === 0 && i === points.length - 1) ||
						(index === points.length - 1 && i === 0))
				) {
					return [point[0], nextY];
				}
				return point;
			}),
		);
	}
	function pointerMove(event: PointerEvent<SVGSVGElement>) {
		if (drag.current === null || !svg.current) return;
		const rect = svg.current.getBoundingClientRect();
		movePoint({
			index: drag.current,
			x: (((event.clientX - rect.left) / rect.width) * 240 - 16) / 208,
			y: 1 - (((event.clientY - rect.top) / rect.height) * 160 - 16) / 128,
		});
	}
	function finishDrag() {
		if (drag.current !== null) {
			drag.current = null;
			onCommit();
		}
	}
	return (
		<div
			className="flex flex-col gap-3 px-4 pb-4"
			data-testid={isHsl ? "hsl-curves-controls" : "curves-controls"}
		>
			<label className="flex justify-between gap-3 text-xs">
				Channel
				<select
					aria-label={isHsl ? "HSL curve channel" : "Curve channel"}
					className="bg-background border rounded px-2 py-1"
					value={channel}
					onChange={(event) => {
						setChannel(Number(event.target.value));
						setSelected(0);
					}}
				>
					{channels.map((label, i) => (
						<option key={label} value={i}>
							{label}
						</option>
					))}
				</select>
			</label>
			<span id={pointInstructionsId} className="sr-only">
				Press Enter or Space to select a curve point. Use the arrow keys to move
				it.
			</span>
			<svg
				ref={svg}
				viewBox="0 0 240 160"
				role="group"
				aria-label={isHsl ? "HSL curve graph" : "Tone curve graph"}
				className="w-full border rounded bg-background touch-none"
				onPointerMove={pointerMove}
				onPointerUp={finishDrag}
				onPointerCancel={finishDrag}
			>
				{isHsl && (
					<>
						<defs>
							<linearGradient id={gradientId}>
								{(channel < 3
									? [
											"#ff0000",
											"#ffff00",
											"#00ff00",
											"#00ffff",
											"#0000ff",
											"#ff00ff",
											"#ff0000",
										]
									: ["#000000", "#ffffff"]
								).map((color, i, stops) => (
									<stop
										key={i}
										offset={`${(i / (stops.length - 1)) * 100}%`}
										stopColor={color}
									/>
								))}
							</linearGradient>
						</defs>
						<rect
							x="16"
							y="16"
							width="208"
							height="128"
							fill={`url(#${gradientId})`}
							opacity="0.2"
						/>
					</>
				)}
				{[0, 0.25, 0.5, 0.75, 1].map((v) => (
					<g key={v} className="text-border" stroke="currentColor">
						<path d={`M${16 + v * 208},16V144 M16,${16 + v * 128}H224`} />
					</g>
				))}
				<path
					d={isHsl ? "M16,80H224" : "M16,144L224,16"}
					stroke="currentColor"
					opacity="0.25"
					strokeDasharray="3 3"
				/>
				<path
					d={drawing.samples
						.map(
							(y, i) =>
								`${i ? "L" : "M"}${16 + (i / 128) * 208},${144 - y * 128}`,
						)
						.join(" ")}
					fill="none"
					stroke={colors[channel]}
					strokeWidth="2"
				/>
				{points.map(([x, y], i) => (
					<circle
						key={i}
						cx={16 + x * 208}
						cy={144 - y * 128}
						r={i === pointIndex ? 5 : 4}
						fill={colors[channel]}
						stroke={focusedPoint === i ? "var(--ring)" : "var(--background)"}
						strokeWidth={focusedPoint === i ? 3 : 1}
						role="button"
						tabIndex={0}
						aria-label={`Curve point ${i + 1}`}
						aria-describedby={pointInstructionsId}
						onFocus={() => {
							setSelected(i);
							setFocusedPoint(i);
						}}
						onBlur={() => setFocusedPoint(null)}
						onClick={() => setSelected(i)}
						onPointerDown={(event) => {
							event.preventDefault();
							setSelected(i);
							drag.current = i;
							event.currentTarget.setPointerCapture(event.pointerId);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								setSelected(i);
								return;
							}
							const dx =
								event.key === "ArrowRight"
									? 0.01
									: event.key === "ArrowLeft"
										? -0.01
										: 0;
							const dy =
								event.key === "ArrowUp"
									? 0.01
									: event.key === "ArrowDown"
										? -0.01
										: 0;
							if (dx || dy) {
								event.preventDefault();
								movePoint({ index: i, x: x + dx, y: y + dy });
								onCommit();
							}
						}}
					/>
				))}
			</svg>
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
			<div className="grid grid-cols-2 gap-2">
				{["Input", "Output"].map((label, axis) => (
					<label key={label} className="text-xs">
						{label}
						<Input
							type="number"
							size="sm"
							aria-label={`Curve ${label.toLowerCase()}`}
							min={0}
							max={1}
							step={0.01}
							value={Number(points[pointIndex][axis].toFixed(3))}
							disabled={
								axis === 0 &&
								(pointIndex === 0 || pointIndex === points.length - 1)
							}
							onChange={(event) => {
								const value = event.currentTarget.valueAsNumber;
								if (Number.isFinite(value))
									movePoint({
										index: pointIndex,
										x: axis === 0 ? value : points[pointIndex][0],
										y: axis === 1 ? value : points[pointIndex][1],
									});
							}}
							onBlur={onCommit}
							onKeyDown={(event) => {
								if (event.key === "Enter") onCommit();
							}}
						/>
					</label>
				))}
			</div>
			<div className="flex flex-wrap gap-1">
				<Button
					size="sm"
					variant="outline"
					disabled={points.length >= 32 || drawing.samples.length < 2}
					onClick={() => {
						let index = 0;
						for (let i = 1; i < points.length - 1; i++)
							if (
								points[i + 1][0] - points[i][0] >
								points[index + 1][0] - points[index][0]
							)
								index = i;
						const x = (points[index][0] + points[index + 1][0]) / 2;
						const sampleIndex = x * (drawing.samples.length - 1);
						const before = Math.floor(sampleIndex);
						const fraction = sampleIndex - before;
						const y =
							drawing.samples[before] * (1 - fraction) +
							drawing.samples[
								Math.min(before + 1, drawing.samples.length - 1)
							] *
								fraction;
						const next = [...points];
						next.splice(index + 1, 0, [x, y]);
						preview(next);
						setSelected(index + 1);
						onCommit();
					}}
				>
					Add point
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={pointIndex === 0 || pointIndex === points.length - 1}
					onClick={() => {
						preview(points.filter((_, i) => i !== pointIndex));
						setSelected(0);
						onCommit();
					}}
				>
					Delete point
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						preview([
							[0, isHsl ? 0.5 : 0],
							[1, isHsl ? 0.5 : 1],
						]);
						setSelected(0);
						onCommit();
					}}
				>
					Reset curve
				</Button>
			</div>
		</div>
	);
}
