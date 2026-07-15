"use client";

import { useEditor, useScenes } from "@/editor/use-editor";
import { mediaTimeToSeconds } from "@/wasm";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { Bookmark } from "@/timeline";
import {
	formatMarkerTime,
	markerLabel,
	sortBookmarksByTime,
} from "@/timeline/bookmarks/marker-list";
import { PanelView } from "./base-panel";

export function MarkersView() {
	const editor = useEditor();
	const bookmarks = useScenes(
		(e) => e.scenes.getActiveSceneOrNull()?.bookmarks ?? null,
	);

	const addAction = (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 gap-1.5 text-xs"
			onClick={() => {
				void editor.scenes.toggleBookmark({
					time: editor.playback.getCurrentTime(),
				});
			}}
			title="Add a marker at the playhead"
		>
			<HugeiconsIcon icon={PlusSignIcon} className="size-3.5" />
			Add marker
		</Button>
	);

	if (!bookmarks) {
		return (
			<PanelView title="Markers">
				<div className="text-muted-foreground p-4 text-sm">
					No project loaded.
				</div>
			</PanelView>
		);
	}

	const sorted = sortBookmarksByTime({ bookmarks });

	if (sorted.length === 0) {
		return (
			<PanelView title="Markers" actions={addAction}>
				<div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
					<p className="font-medium">No markers yet</p>
					<p className="text-muted-foreground text-sm text-balance">
						Add a marker at the playhead to jump back to it later.
					</p>
				</div>
			</PanelView>
		);
	}

	return (
		<PanelView title="Markers" actions={addAction}>
			<div className="flex flex-col gap-1 pb-2">
				{sorted.map((bookmark) => (
					<MarkerRow key={bookmark.time} bookmark={bookmark} />
				))}
			</div>
		</PanelView>
	);
}

function MarkerRow({ bookmark }: { bookmark: Bookmark }) {
	const editor = useEditor();
	const seconds = mediaTimeToSeconds({ time: bookmark.time });

	return (
		<div className="group border-border bg-muted/40 hover:bg-muted/60 flex items-center gap-2 rounded-md border p-2 transition-colors">
			<span
				className="size-2.5 shrink-0 rounded-full"
				style={{ backgroundColor: bookmark.color ?? "var(--primary)" }}
			/>
			<button
				type="button"
				className="flex min-w-0 flex-1 flex-col items-start text-left"
				onClick={() => editor.playback.seek({ time: bookmark.time })}
				title="Jump to marker"
			>
				<span className="text-foreground w-full truncate text-xs">
					{markerLabel({ bookmark })}
				</span>
				<span className="text-muted-foreground text-[10px] tabular-nums">
					{formatMarkerTime({ seconds })}
				</span>
			</button>
			<Button
				variant="ghost"
				size="icon"
				className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
				onClick={() => {
					void editor.scenes.removeBookmark({ time: bookmark.time });
				}}
				title="Delete marker"
			>
				<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
			</Button>
		</div>
	);
}
