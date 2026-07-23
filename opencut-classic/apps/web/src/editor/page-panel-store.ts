import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PageId } from "@/panels/pages";

/**
 * Panel sizes for the non-Edit workspace pages (UX-002). Edit keeps its own
 * legacy `usePanelStore` untouched (the migration invariant), so this store
 * only ever holds sizes for Media/Color/Audio/Deliver. Sizes are keyed
 * `${page}:${panel}` in a flat map — no rigid per-page schema, so a page can
 * add or drop panels without a store migration.
 */
interface PagePanelState {
	sizes: Record<string, number>;
	setSize: (args: { page: PageId; panel: string; size: number }) => void;
}

function key({ page, panel }: { page: PageId; panel: string }): string {
	return `${page}:${panel}`;
}

export const usePagePanelStore = create<PagePanelState>()(
	persist(
		(set) => ({
			sizes: {},
			setSize: ({ page, panel, size }) =>
				set((state) => ({
					sizes: { ...state.sizes, [key({ page, panel })]: size },
				})),
		}),
		{
			name: "page-panel-sizes",
			version: 1,
			partialize: (state) => ({ sizes: state.sizes }),
		},
	),
);

/**
 * Read a stored size once (for a ResizablePanel `defaultSize`), falling back to
 * the page's default when the user hasn't dragged it yet. Not reactive — panel
 * sizes are only read at mount, then owned by the layout library.
 */
export function getPagePanelSize({
	page,
	panel,
	fallback,
}: {
	page: PageId;
	panel: string;
	fallback: number;
}): number {
	return usePagePanelStore.getState().sizes[key({ page, panel })] ?? fallback;
}
