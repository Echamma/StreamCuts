"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useTextEditRequestStore } from "@/preview/text-edit-request-store";
import type { TextElement } from "@/timeline";
import { getTextTracks } from "@/timeline/scene-tracks-view";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 10);
	return `${m}:${String(s).padStart(2, "0")}.${ms}`;
}

interface CaptionRow {
	trackId: string;
	elementId: string;
	element: TextElement;
	startSec: number;
}

function CaptionRow({
	trackId,
	elementId,
	element,
	startSec,
}: CaptionRow) {
	const editor = useEditor();
	const requestTextEdit = useTextEditRequestStore((s) => s.requestTextEdit);
	const committed =
		typeof element.params.content === "string" ? element.params.content : "";
	const [draft, setDraft] = useState(committed);
	const isFocusedRef = useRef(false);

	useEffect(() => {
		if (!isFocusedRef.current) {
			setDraft(committed);
		}
	}, [committed]);

	const commit = () => {
		isFocusedRef.current = false;
		if (draft === committed) return;
		editor.timeline.updateElements({
			updates: [{ trackId, elementId, patch: { params: { content: draft } } }],
		});
	};

	return (
		<div className="group flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-2 hover:bg-muted/60 transition-colors">
			<div className="flex items-center justify-between gap-2">
				<button
					type="button"
					className="text-[10px] text-muted-foreground tabular-nums hover:text-foreground transition-colors"
					onClick={() => {
						editor.selection.setSelectedElements({ elements: [{ trackId, elementId }] });
						editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: startSec }) });
					}}
				>
					{formatTime(startSec)}
				</button>
				<button
					type="button"
					className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground"
					onClick={() => requestTextEdit({ trackId, elementId })}
					title="Edit in canvas"
				>
					Edit in canvas
				</button>
			</div>
			<textarea
				className="w-full resize-none bg-transparent text-xs text-foreground outline-none"
				rows={2}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onFocus={() => { isFocusedRef.current = true; }}
				onBlur={commit}
				onClick={(e) => e.stopPropagation()}
			/>
		</div>
	);
}

export function CaptionList() {
	const editor = useEditor();

	const scene = editor.scenes.getActiveScene();
	const textTracks = getTextTracks({ tracks: scene.tracks });

	const rows: CaptionRow[] = textTracks.flatMap((track) =>
		(track.elements as TextElement[]).map((el) => ({
			trackId: track.id,
			elementId: el.id,
			element: el,
			startSec: mediaTimeToSeconds({ time: el.startTime }),
		})),
	);

	rows.sort((a, b) => a.startSec - b.startSec);

	if (rows.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-1 pb-2">
			{rows.map((row) => (
				<CaptionRow key={row.elementId} {...row} />
			))}
		</div>
	);
}
