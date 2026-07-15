"use client";

import { useMemo } from "react";
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
import {
	clipMarkerLabel,
	collectClipMarkers,
	type CollectedClipMarker,
} from "@/timeline/clip-markers";
import { PanelView } from "./base-panel";

export function MarkersView() {
	const editor = useEditor();
	const bookmarks = useScenes(
		(e) => e.scenes.getActiveSceneOrNull()?.bookmarks ?? null,
	);
	const tracks = useScenes(
		(e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null,
	);
	const clipMarkers = useMemo(
		() => (tracks ? collectClipMarkers({ tracks }) : []),
		[tracks],
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
	const isEmpty = sorted.length === 0 && clipMarkers.length === 0;

	if (isEmpty) {
		return (
			<PanelView title="Markers" actions={addAction}>
				<div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
					<p className="font-medium">No markers yet</p>
					<p className="text-muted-foreground text-sm text-balance">
						Add a marker at the playhead to jump back to it later, or right-click
						a clip to mark a moment on it.
					</p>
				</div>
			</PanelView>
		);
	}

	return (
		<PanelView title="Markers" actions={addAction}>
			<div className="flex flex-col gap-3 pb-2">
				{sorted.length > 0 && (
					<Section title="Timeline">
						{sorted.map((bookmark) => (
							<BookmarkRow key={bookmark.time} bookmark={bookmark} />
						))}
					</Section>
				)}
				{clipMarkers.length > 0 && (
					<Section title="Clips">
						{clipMarkers.map((entry) => (
							<ClipMarkerRow
								key={`${entry.elementId}:${entry.marker.time}`}
								entry={entry}
							/>
						))}
					</Section>
				)}
			</div>
		</PanelView>
	);
}

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<p className="text-muted-foreground px-1 text-[10px] font-medium tracking-wide uppercase">
				{title}
			</p>
			{children}
		</div>
	);
}

function BookmarkRow({ bookmark }: { bookmark: Bookmark }) {
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

function ClipMarkerRow({ entry }: { entry: CollectedClipMarker }) {
	const editor = useEditor();
	const seconds = mediaTimeToSeconds({ time: entry.absoluteTime });
	const label = clipMarkerLabel({
		marker: entry.marker,
		elementName: entry.elementName,
	});
	// Only surface the clip name in the sub-line when the label is the note —
	// otherwise the label already is the clip name and repeating it is noise.
	const showClipName = label !== entry.elementName;

	return (
		<div className="group border-border bg-muted/40 hover:bg-muted/60 flex items-center gap-2 rounded-md border p-2 transition-colors">
			<span
				className="size-2.5 shrink-0 rounded-full"
				style={{ backgroundColor: entry.marker.color ?? "var(--primary)" }}
			/>
			<button
				type="button"
				className="flex min-w-0 flex-1 flex-col items-start text-left"
				onClick={() => editor.playback.seek({ time: entry.absoluteTime })}
				title="Jump to clip marker"
			>
				<span className="text-foreground w-full truncate text-xs">{label}</span>
				<span className="text-muted-foreground flex w-full items-center gap-1.5 text-[10px]">
					{showClipName && (
						<span className="min-w-0 truncate">{entry.elementName}</span>
					)}
					<span className="tabular-nums">{formatMarkerTime({ seconds })}</span>
				</span>
			</button>
			<Button
				variant="ghost"
				size="icon"
				className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
				onClick={() => {
					editor.timeline.removeClipMarker({
						trackId: entry.trackId,
						elementId: entry.elementId,
						localTime: entry.marker.time,
					});
				}}
				title="Delete clip marker"
			>
				<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
			</Button>
		</div>
	);
}
