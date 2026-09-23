"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { prepareLut } from "../luts/prepared-lut";
import type { EffectControlProps } from "./effect-controls";

export function LutControl({
	values,
	previewParam,
	onCommit,
}: EffectControlProps) {
	const input = useRef<HTMLInputElement>(null);
	const request = useRef(0);
	const intensityId = useId();
	useEffect(
		() => () => {
			request.current++;
		},
		[],
	);
	const [importError, setImportError] = useState("");
	const source = typeof values.cube === "string" ? values.cube : "";
	const prepared = source ? prepareLut({ kind: "cube", source }) : null;
	const intensity = typeof values.intensity === "number" ? values.intensity : 1;
	const error = importError || prepared?.error;
	return (
		<div className="flex flex-col gap-3 px-4 pb-4" data-testid="lut-controls">
			<input
				ref={input}
				type="file"
				accept=".cube"
				aria-label="Import LUT"
				className="sr-only"
				onChange={async (event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					if (!file) return;
					const id = ++request.current;
					try {
						if (file.size > 16 * 1024 * 1024)
							throw new Error("Choose a LUT file smaller than 16 MB.");
						const text = await file.text();
						if (id !== request.current) return;
						const result = prepareLut({ kind: "cube", source: text });
						if (result.error) throw new Error(result.error);
						setImportError("");
						previewParam("cube")(text);
						onCommit();
					} catch (error) {
						if (id === request.current)
							setImportError(
								error instanceof Error ? error.message : String(error),
							);
					}
				}}
			/>
			<Button
				variant="outline"
				size="sm"
				onClick={() => input.current?.click()}
			>
				{source ? "Replace LUT…" : "Import .cube LUT…"}
			</Button>
			{prepared?.value && (
				<p className="text-muted-foreground text-xs" role="status">
					LUT loaded · {prepared.value.uniforms.lutSize} nodes per axis
				</p>
			)}
			{error && (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			)}
			<label
				htmlFor={intensityId}
				className="flex items-center justify-between gap-3 text-xs"
			>
				Intensity (%)
				<Input
					id={intensityId}
					aria-label="LUT intensity"
					type="number"
					min={0}
					max={100}
					step={1}
					size="sm"
					className="w-20"
					value={Math.round(intensity * 100)}
					onChange={(event) => {
						const value = event.currentTarget.valueAsNumber;
						if (Number.isFinite(value))
							previewParam("intensity")(
								Math.max(0, Math.min(100, value)) / 100,
							);
					}}
					onBlur={onCommit}
					onKeyDown={(event) => {
						if (event.key === "Enter") onCommit();
					}}
				/>
			</label>
			{source && (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						request.current++;
						setImportError("");
						previewParam("cube")("");
						onCommit();
					}}
				>
					Remove LUT
				</Button>
			)}
		</div>
	);
}
