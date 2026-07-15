"use client";

import { useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import type { TextElement } from "@/timeline";
import type { ParamValue, ParamValues } from "@/params";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/ui/color-picker";
import { FontPicker } from "@/components/ui/font-picker";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	useCaptionStylePresets,
	saveCaptionStylePreset,
	deleteCaptionStylePreset,
	type CaptionStylePreset,
} from "@/subtitles/caption-style-presets-store";
import { captionAnimationConfigToParams } from "@/subtitles/animation/params";
import { CAPTION_ANIMATION_MODES } from "@/subtitles/animation/types";
import { X } from "lucide-react";

// Style-only param keys — excludes content, transform, opacity, blendMode.
// Includes the caption.* animation keys so "save current style as preset"
// captures the word-by-word animation too.
const STYLE_PARAM_KEYS = [
	"fontFamily",
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"caption.mode",
	"caption.highlightColor",
	"caption.highlightBackground",
	"caption.peakScale",
	"caption.peakHoldSeconds",
	"caption.easeSeconds",
] as const;

const CAPTION_MODE_LABELS: Record<string, string> = {
	none: "None",
	wordHighlight: "Word Highlight",
	pop: "Pop",
	bounce: "Bounce",
	typewriter: "Typewriter",
	karaokeLine: "Karaoke",
};

type StyleParamKey = (typeof STYLE_PARAM_KEYS)[number];

interface RowRef {
	trackId: string;
	elementId: string;
	element: TextElement;
}

// ─── Presets bar ─────────────────────────────────────────────────────────────

function PresetsBar({
	currentParams,
	onApply,
}: {
	currentParams: Partial<ParamValues>;
	onApply: (preset: CaptionStylePreset) => void;
}) {
	const presets = useCaptionStylePresets();
	const [saving, setSaving] = useState(false);
	const [draftName, setDraftName] = useState("");
	const nameInputRef = useRef<HTMLInputElement>(null);

	const handleSave = () => {
		const name = draftName.trim();
		if (!name) return;
		const styleParams: Partial<ParamValues> = {};
		for (const key of STYLE_PARAM_KEYS) {
			if (currentParams[key] !== undefined) {
				styleParams[key] = currentParams[key];
			}
		}
		saveCaptionStylePreset({ name, params: styleParams });
		setSaving(false);
		setDraftName("");
	};

	return (
		<div className="flex flex-col gap-2">
			{/* Preset chips */}
			{presets.length > 0 && (
				<div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
					{presets.map((preset) => (
						<div
							key={preset.id}
							className="group flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-accent px-2.5 py-1 text-xs"
						>
							<button
								type="button"
								className="truncate max-w-[100px] text-foreground/80 hover:text-foreground transition-colors"
								onClick={() => onApply(preset)}
								title={`Apply "${preset.name}"`}
							>
								{preset.name}
							</button>
							<button
								type="button"
								className="ml-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
								aria-label={`Delete preset "${preset.name}"`}
								onClick={() => deleteCaptionStylePreset({ id: preset.id })}
							>
								<X className="size-3" />
							</button>
						</div>
					))}
				</div>
			)}

			{/* Save as preset */}
			{saving ? (
				<div className="flex gap-1.5">
					<input
						ref={nameInputRef}
						autoFocus
						className="border-input bg-accent h-7 flex-1 rounded-md border px-2 text-xs outline-none focus:border-primary"
						placeholder="Preset name…"
						value={draftName}
						onChange={(e) => setDraftName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleSave();
							if (e.key === "Escape") {
								setSaving(false);
								setDraftName("");
							}
						}}
					/>
					<Button size="sm" className="h-7 px-2 text-xs" onClick={handleSave}>
						Save
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2 text-xs"
						onClick={() => {
							setSaving(false);
							setDraftName("");
						}}
					>
						Cancel
					</Button>
				</div>
			) : (
				<Button
					variant="outline"
					size="sm"
					className="h-7 w-full text-xs"
					onClick={() => {
						setSaving(true);
						setDraftName("");
					}}
				>
					Save current style as preset
				</Button>
			)}
		</div>
	);
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CaptionStylePanel() {
	const editor = useEditor();
	const scene = editor.scenes.getActiveScene();
	const textTracks = scene.tracks.overlay.filter((t) => t.type === "text");

	const rows: RowRef[] = textTracks.flatMap((track) =>
		(track.elements as TextElement[]).map((el) => ({
			trackId: track.id,
			elementId: el.id,
			element: el,
		})),
	);

	const refParams = rows[0]?.element.params ?? {};

	const previewAll = (paramKey: string, value: ParamValue) => {
		if (rows.length === 0) return;
		editor.timeline.previewElements({
			updates: rows.map(({ trackId, elementId, element }) => ({
				trackId,
				elementId,
				updates: { params: { ...element.params, [paramKey]: value } },
			})),
		});
	};

	const commitAll = () => editor.timeline.commitPreview();

	const updateAll = (paramKey: string, value: ParamValue) => {
		if (rows.length === 0) return;
		editor.timeline.updateElements({
			updates: rows.map(({ trackId, elementId }) => ({
				trackId,
				elementId,
				patch: { params: { [paramKey]: value } },
			})),
		});
	};

	const applyPreset = (preset: CaptionStylePreset) => {
		if (rows.length === 0) return;
		// A baked preset carries its animation as a typed block; flatten it into
		// caption.* params so it rides the normal params update path. User-saved
		// presets already store caption.* inside `params`.
		const merged: Partial<ParamValues> = {
			...preset.params,
			...(preset.animation
				? captionAnimationConfigToParams({ animation: preset.animation })
				: {}),
		};
		editor.timeline.updateElements({
			updates: rows.map(({ trackId, elementId }) => ({
				trackId,
				elementId,
				// Cast: updateElements shallow-merges params, so passing a subset is safe
				patch: { params: merged as ParamValues },
			})),
		});
	};

	// ── Number field drafts (all hooks before any early return) ──
	const fontSize =
		typeof refParams.fontSize === "number" ? refParams.fontSize : 15;
	const fontSizeDraft = usePropertyDraft({
		displayValue: String(fontSize),
		parse: (s) => {
			const n = parseFloat(s);
			return Number.isNaN(n) ? null : Math.max(1, n);
		},
		onPreview: (v) => previewAll("fontSize", v),
		onCommit: commitAll,
	});

	const letterSpacing =
		typeof refParams.letterSpacing === "number" ? refParams.letterSpacing : 0;
	const letterSpacingDraft = usePropertyDraft({
		displayValue: String(letterSpacing),
		parse: (s) => {
			const n = parseFloat(s);
			return Number.isNaN(n) ? null : n;
		},
		onPreview: (v) => previewAll("letterSpacing", v),
		onCommit: commitAll,
	});

	const lineHeight =
		typeof refParams.lineHeight === "number" ? refParams.lineHeight : 1.2;
	const lineHeightDraft = usePropertyDraft({
		displayValue: String(lineHeight),
		parse: (s) => {
			const n = parseFloat(s);
			return Number.isNaN(n) ? null : Math.max(0.1, n);
		},
		onPreview: (v) => previewAll("lineHeight", v),
		onCommit: commitAll,
	});

	const cornerRadius =
		typeof refParams["background.cornerRadius"] === "number"
			? refParams["background.cornerRadius"]
			: 0;
	const cornerRadiusDraft = usePropertyDraft({
		displayValue: String(cornerRadius),
		parse: (s) => {
			const n = parseFloat(s);
			return Number.isNaN(n) ? null : Math.min(50, Math.max(0, n));
		},
		onPreview: (v) => previewAll("background.cornerRadius", v),
		onCommit: commitAll,
	});

	const paddingX =
		typeof refParams["background.paddingX"] === "number"
			? refParams["background.paddingX"]
			: 30;
	const paddingXDraft = usePropertyDraft({
		displayValue: String(paddingX),
		parse: (s) => {
			const n = parseFloat(s);
			return Number.isNaN(n) ? null : Math.max(0, n);
		},
		onPreview: (v) => previewAll("background.paddingX", v),
		onCommit: commitAll,
	});

	const paddingY =
		typeof refParams["background.paddingY"] === "number"
			? refParams["background.paddingY"]
			: 42;
	const paddingYDraft = usePropertyDraft({
		displayValue: String(paddingY),
		parse: (s) => {
			const n = parseFloat(s);
			return Number.isNaN(n) ? null : Math.max(0, n);
		},
		onPreview: (v) => previewAll("background.paddingY", v),
		onCommit: commitAll,
	});

	if (rows.length === 0) return null;

	const bgEnabled = Boolean(refParams["background.enabled"]);
	const captionMode = String(refParams["caption.mode"] ?? "none");
	const usesHighlightColor =
		captionMode === "wordHighlight" || captionMode === "karaokeLine";

	return (
		<Section
			collapsible
			defaultOpen={false}
			sectionKey="caption-style-panel"
			showTopBorder
			showBottomBorder={false}
		>
			<SectionHeader>
				<SectionTitle>Caption Style</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					{/* Presets */}
					<PresetsBar currentParams={refParams} onApply={applyPreset} />

					{/* Word-by-word animation */}
					<SectionField label="Animation">
						<Select
							value={captionMode}
							onValueChange={(v) => updateAll("caption.mode", v)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CAPTION_ANIMATION_MODES.map((mode) => (
									<SelectItem key={mode} value={mode}>
										{CAPTION_MODE_LABELS[mode] ?? mode}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					{usesHighlightColor && (
						<SectionField label="Highlight">
							<ColorPicker
								value={String(refParams["caption.highlightColor"] ?? "#facc15")
									.replace(/^#/, "")
									.toUpperCase()}
								onChange={(color) =>
									previewAll("caption.highlightColor", `#${color}`)
								}
								onChangeEnd={(color) => {
									previewAll("caption.highlightColor", `#${color}`);
									commitAll();
								}}
							/>
						</SectionField>
					)}

					{/* Font family */}
					<SectionField label="Font Family">
						<FontPicker
							defaultValue={String(refParams.fontFamily ?? "Arial")}
							onValueChange={(family) => updateAll("fontFamily", family)}
						/>
					</SectionField>

					<SectionField label="Font Size">
						<NumberField
							value={fontSizeDraft.displayValue}
							dragSensitivity="slow"
							onFocus={fontSizeDraft.onFocus}
							onChange={fontSizeDraft.onChange as React.ChangeEventHandler<HTMLInputElement>}
							onBlur={fontSizeDraft.onBlur as React.FocusEventHandler<HTMLInputElement>}
							onScrub={(v) => previewAll("fontSize", Math.max(1, v))}
							onScrubEnd={commitAll}
						/>
					</SectionField>

					<SectionField label="Color">
						<ColorPicker
							value={String(refParams.color ?? "#ffffff")
								.replace(/^#/, "")
								.toUpperCase()}
							onChange={(color) => previewAll("color", `#${color}`)}
							onChangeEnd={(color) => {
								previewAll("color", `#${color}`);
								commitAll();
							}}
						/>
					</SectionField>

					<SectionField label="Align">
						<Select
							value={String(refParams.textAlign ?? "center")}
							onValueChange={(v) => updateAll("textAlign", v)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="left">Left</SelectItem>
								<SelectItem value="center">Center</SelectItem>
								<SelectItem value="right">Right</SelectItem>
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Weight">
						<Select
							value={String(refParams.fontWeight ?? "normal")}
							onValueChange={(v) => updateAll("fontWeight", v)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="normal">Normal</SelectItem>
								<SelectItem value="bold">Bold</SelectItem>
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Style">
						<Select
							value={String(refParams.fontStyle ?? "normal")}
							onValueChange={(v) => updateAll("fontStyle", v)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="normal">Normal</SelectItem>
								<SelectItem value="italic">Italic</SelectItem>
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Decoration">
						<Select
							value={String(refParams.textDecoration ?? "none")}
							onValueChange={(v) => updateAll("textDecoration", v)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">None</SelectItem>
								<SelectItem value="underline">Underline</SelectItem>
								<SelectItem value="line-through">Line Through</SelectItem>
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Letter Spacing">
						<NumberField
							value={letterSpacingDraft.displayValue}
							dragSensitivity="slow"
							onFocus={letterSpacingDraft.onFocus}
							onChange={letterSpacingDraft.onChange as React.ChangeEventHandler<HTMLInputElement>}
							onBlur={letterSpacingDraft.onBlur as React.FocusEventHandler<HTMLInputElement>}
							onScrub={(v) => previewAll("letterSpacing", v)}
							onScrubEnd={commitAll}
						/>
					</SectionField>

					<SectionField label="Line Height">
						<NumberField
							value={lineHeightDraft.displayValue}
							dragSensitivity="slow"
							onFocus={lineHeightDraft.onFocus}
							onChange={lineHeightDraft.onChange as React.ChangeEventHandler<HTMLInputElement>}
							onBlur={lineHeightDraft.onBlur as React.FocusEventHandler<HTMLInputElement>}
							onScrub={(v) => previewAll("lineHeight", Math.max(0.1, v))}
							onScrubEnd={commitAll}
						/>
					</SectionField>

					<SectionField label="Background">
						<Switch
							checked={bgEnabled}
							onCheckedChange={(checked) =>
								updateAll("background.enabled", checked)
							}
						/>
					</SectionField>

					{bgEnabled && (
						<>
							<SectionField label="BG Color">
								<ColorPicker
									value={String(refParams["background.color"] ?? "#000000")
										.replace(/^#/, "")
										.toUpperCase()}
									onChange={(color) =>
										previewAll("background.color", `#${color}`)
									}
									onChangeEnd={(color) => {
										previewAll("background.color", `#${color}`);
										commitAll();
									}}
								/>
							</SectionField>
							<SectionField label="BG Radius">
								<NumberField
									value={cornerRadiusDraft.displayValue}
									dragSensitivity="slow"
									onFocus={cornerRadiusDraft.onFocus}
									onChange={cornerRadiusDraft.onChange as React.ChangeEventHandler<HTMLInputElement>}
									onBlur={cornerRadiusDraft.onBlur as React.FocusEventHandler<HTMLInputElement>}
									onScrub={(v) =>
										previewAll(
											"background.cornerRadius",
											Math.min(50, Math.max(0, v)),
										)
									}
									onScrubEnd={commitAll}
								/>
							</SectionField>
							<SectionField label="BG Padding X">
								<NumberField
									value={paddingXDraft.displayValue}
									dragSensitivity="slow"
									onFocus={paddingXDraft.onFocus}
									onChange={paddingXDraft.onChange as React.ChangeEventHandler<HTMLInputElement>}
									onBlur={paddingXDraft.onBlur as React.FocusEventHandler<HTMLInputElement>}
									onScrub={(v) =>
										previewAll("background.paddingX", Math.max(0, v))
									}
									onScrubEnd={commitAll}
								/>
							</SectionField>
							<SectionField label="BG Padding Y">
								<NumberField
									value={paddingYDraft.displayValue}
									dragSensitivity="slow"
									onFocus={paddingYDraft.onFocus}
									onChange={paddingYDraft.onChange as React.ChangeEventHandler<HTMLInputElement>}
									onBlur={paddingYDraft.onBlur as React.FocusEventHandler<HTMLInputElement>}
									onScrub={(v) =>
										previewAll("background.paddingY", Math.max(0, v))
									}
									onScrubEnd={commitAll}
								/>
							</SectionField>
						</>
					)}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
