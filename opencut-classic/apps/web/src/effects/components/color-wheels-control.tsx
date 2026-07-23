"use client";

import { useRef } from "react";
import type { ParamValue, ParamValues } from "@/params";
import { Slider } from "@/components/ui/slider";
import { SectionField } from "@/components/section";
import {
	balanceToPad,
	clampToDisc,
	padToBalance,
} from "./color-wheel-math";

interface WheelSpec {
	prefix: string;
	label: string;
	/** Neutral per-channel value (0 for lift/offset, 1 for gamma/gain). */
	neutral: number;
	/** Balance a primary reaches at full pad radius. */
	amount: number;
	min: number;
	max: number;
	step: number;
}

const WHEELS: WheelSpec[] = [
	{ prefix: "lift", label: "Lift", neutral: 0, amount: 0.5, min: -0.5, max: 0.5, step: 0.01 },
	{ prefix: "gamma", label: "Gamma", neutral: 1, amount: 0.5, min: 0.1, max: 3, step: 0.01 },
	{ prefix: "gain", label: "Gain", neutral: 1, amount: 0.5, min: 0, max: 3, step: 0.01 },
	{ prefix: "offset", label: "Offset", neutral: 0, amount: 0.5, min: -0.5, max: 0.5, step: 0.01 },
];

interface ScalarSpec {
	key: string;
	label: string;
	min: number;
	max: number;
	step: number;
}

const SCALARS: ScalarSpec[] = [
	{ key: "contrast", label: "Contrast", min: 0, max: 2, step: 0.01 },
	{ key: "pivot", label: "Pivot", min: 0, max: 1, step: 0.01 },
	{ key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01 },
	{ key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01 },
	{ key: "tint", label: "Tint", min: -1, max: 1, step: 0.01 },
	{ key: "hue", label: "Hue", min: -180, max: 180, step: 1 },
];

const DISC_SIZE = 96;
const DISC_RADIUS = DISC_SIZE / 2 - 4;

function num({
	values,
	key,
	fallback,
}: {
	values: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = values[key];
	return typeof value === "number" ? value : fallback;
}

function clamp({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return Math.max(min, Math.min(max, value));
}

function ColorWheel({
	spec,
	values,
	previewParam,
	onCommit,
}: {
	spec: WheelSpec;
	values: ParamValues;
	previewParam: (key: string) => (value: ParamValue) => void;
	onCommit: () => void;
}) {
	const svgRef = useRef<SVGSVGElement | null>(null);
	const dragging = useRef(false);

	const r = num({ values, key: `${spec.prefix}_r`, fallback: spec.neutral });
	const g = num({ values, key: `${spec.prefix}_g`, fallback: spec.neutral });
	const b = num({ values, key: `${spec.prefix}_b`, fallback: spec.neutral });
	const master = num({ values, key: `${spec.prefix}_master`, fallback: 0 });

	const pad = balanceToPad({
		balance: { r: r - spec.neutral, g: g - spec.neutral, b: b - spec.neutral },
		amount: spec.amount,
	});
	const center = DISC_SIZE / 2;
	const dotX = center + pad.x * DISC_RADIUS;
	const dotY = center - pad.y * DISC_RADIUS;

	const applyFromPointer = ({ event }: { event: React.PointerEvent }) => {
		const svg = svgRef.current;
		if (!svg) return;
		const rect = svg.getBoundingClientRect();
		const point = clampToDisc({
			point: {
				x: (event.clientX - rect.left - center) / DISC_RADIUS,
				y: -(event.clientY - rect.top - center) / DISC_RADIUS,
			},
		});
		const balance = padToBalance({ point, amount: spec.amount });
		previewParam(`${spec.prefix}_r`)(
			clamp({ value: spec.neutral + balance.r, min: spec.min, max: spec.max }),
		);
		previewParam(`${spec.prefix}_g`)(
			clamp({ value: spec.neutral + balance.g, min: spec.min, max: spec.max }),
		);
		previewParam(`${spec.prefix}_b`)(
			clamp({ value: spec.neutral + balance.b, min: spec.min, max: spec.max }),
		);
	};

	const resetBalance = () => {
		previewParam(`${spec.prefix}_r`)(spec.neutral);
		previewParam(`${spec.prefix}_g`)(spec.neutral);
		previewParam(`${spec.prefix}_b`)(spec.neutral);
		onCommit();
	};

	return (
		<div className="flex flex-col items-center gap-2">
			<span className="text-muted-foreground text-xs font-medium">
				{spec.label}
			</span>
			<svg
				ref={svgRef}
				width={DISC_SIZE}
				height={DISC_SIZE}
				className="cursor-crosshair touch-none"
				onPointerDown={(event) => {
					dragging.current = true;
					event.currentTarget.setPointerCapture(event.pointerId);
					applyFromPointer({ event });
				}}
				onPointerMove={(event) => {
					if (dragging.current) applyFromPointer({ event });
				}}
				onPointerUp={(event) => {
					if (dragging.current) {
						dragging.current = false;
						event.currentTarget.releasePointerCapture(event.pointerId);
						onCommit();
					}
				}}
				onDoubleClick={resetBalance}
			>
				<defs>
					<radialGradient id={`wheel-${spec.prefix}`} cx="50%" cy="50%" r="50%">
						<stop offset="0%" stopColor="rgb(128,128,128)" />
						<stop offset="100%" stopColor="rgb(64,64,64)" />
					</radialGradient>
				</defs>
				<circle
					cx={center}
					cy={center}
					r={DISC_RADIUS}
					fill={`url(#wheel-${spec.prefix})`}
					stroke="currentColor"
					strokeOpacity={0.2}
				/>
				<circle
					cx={dotX}
					cy={dotY}
					r={5}
					fill="white"
					stroke="black"
					strokeOpacity={0.6}
				/>
			</svg>
			<Slider
				className="w-[96px]"
				value={[master]}
				min={spec.min}
				max={spec.max}
				step={spec.step}
				onValueChange={(next) =>
					previewParam(`${spec.prefix}_master`)(next[0] ?? 0)
				}
				onValueCommit={onCommit}
				aria-label={`${spec.label} master`}
			/>
		</div>
	);
}

/**
 * Custom grading control for the color-wheels effect (COL-002 UI): four
 * trackballs (lift/gamma/gain/offset) plus tone/color sliders, replacing the
 * generic 22-slider param list.
 */
export function ColorWheelsControl({
	values,
	previewParam,
	onCommit,
}: {
	values: ParamValues;
	previewParam: (key: string) => (value: ParamValue) => void;
	onCommit: () => void;
}) {
	return (
		<div className="flex flex-col gap-4 p-4">
			<div className="grid grid-cols-2 gap-4">
				{WHEELS.map((spec) => (
					<ColorWheel
						key={spec.prefix}
						spec={spec}
						values={values}
						previewParam={previewParam}
						onCommit={onCommit}
					/>
				))}
			</div>
			<div className="flex flex-col gap-3">
				{SCALARS.map((scalar) => {
					const fallback = scalar.key === "pivot" ? 0.5 : scalar.key === "contrast" || scalar.key === "saturation" ? 1 : 0;
					const value = num({ values, key: scalar.key, fallback });
					return (
						<SectionField key={scalar.key} label={scalar.label}>
							<div className="flex items-center gap-3">
								<Slider
									value={[value]}
									min={scalar.min}
									max={scalar.max}
									step={scalar.step}
									onValueChange={(next) =>
										previewParam(scalar.key)(next[0] ?? fallback)
									}
									onValueCommit={onCommit}
									aria-label={scalar.label}
								/>
								<span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
									{value.toFixed(scalar.step < 1 ? 2 : 0)}
								</span>
							</div>
						</SectionField>
					);
				})}
			</div>
		</div>
	);
}
