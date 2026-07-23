import { create } from "zustand";
import { DEFAULT_PAGE, isPageReady, type PageId } from "@/panels/pages";

/**
 * Which workspace page is active (UX-001). Kept out of the document store — a
 * page switch is a pure view change. Not persisted yet; last-active-page
 * persistence per project is UX-005. Defaults to Edit so, with the pages-shell
 * flag off, the app renders exactly today's layout.
 */
interface PageState {
	activePage: PageId;
	setActivePage: (args: { page: PageId }) => void;
	resetPage: () => void;
}

export const usePageStore = create<PageState>()((set) => ({
	activePage: DEFAULT_PAGE,
	setActivePage: ({ page }) => {
		// Ignore switches to pages that aren't finished yet — the page bar keeps
		// them disabled, but shortcuts/deep-links could still aim at one.
		if (!isPageReady({ page })) return;
		set({ activePage: page });
	},
	resetPage: () => set({ activePage: DEFAULT_PAGE }),
}));
