import type { Bookmark } from "@/timeline";

/** Bookmarks ordered by timeline position, earliest first. Non-mutating. */
export function sortBookmarksByTime({
	bookmarks,
}: {
	bookmarks: Bookmark[];
}): Bookmark[] {
	return [...bookmarks].sort((a, b) => a.time - b.time);
}

/**
 * A marker's position as a compact `M:SS.d` label (minutes : seconds . tenths),
 * matching the caption list. Non-finite or negative input reads as `0`.
 */
export function formatMarkerTime({ seconds }: { seconds: number }): string {
	const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	const minutes = Math.floor(safe / 60);
	const wholeSeconds = Math.floor(safe % 60);
	const tenths = Math.floor((safe % 1) * 10);
	return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${tenths}`;
}

/** A concise display label for a marker: its note if any, else "Marker". */
export function markerLabel({ bookmark }: { bookmark: Bookmark }): string {
	const note = bookmark.note?.trim();
	return note && note.length > 0 ? note : "Marker";
}
