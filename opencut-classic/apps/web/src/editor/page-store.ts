import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_PAGE, isPageReady, type PageId } from "@/panels/pages";

/**
 * Which workspace page is active (UX-001), plus the last page used per project
 * (UX-005). A page switch is a pure view change, so `activePage` is transient
 * session state and is NOT persisted; only `lastByProject` is, so reopening a
 * project restores the page you left it on.
 */
interface PageState {
	activePage: PageId;
	/** Last ready page used per project id — persisted. */
	lastByProject: Record<string, PageId>;
	setActivePage: (args: { page: PageId }) => void;
	rememberProjectPage: (args: { projectId: string; page: PageId }) => void;
	resetPage: () => void;
}

export const usePageStore = create<PageState>()(
	persist(
		(set) => ({
			activePage: DEFAULT_PAGE,
			lastByProject: {},
			setActivePage: ({ page }) => {
				// Ignore switches to pages that aren't finished yet — the page bar
				// keeps them disabled, but shortcuts/deep-links could still aim at one.
				if (!isPageReady({ page })) return;
				set({ activePage: page });
			},
			rememberProjectPage: ({ projectId, page }) => {
				if (!isPageReady({ page })) return;
				set((state) => ({
					lastByProject: { ...state.lastByProject, [projectId]: page },
				}));
			},
			resetPage: () => set({ activePage: DEFAULT_PAGE }),
		}),
		{
			name: "page-state",
			version: 1,
			// Only the per-project memory persists; the active page is transient.
			partialize: (state) => ({ lastByProject: state.lastByProject }),
		},
	),
);
