"use client";

import { useEffect } from "react";
import { usePageStore } from "@/editor/page-store";
import { useFlag } from "@/flags";
import { isPageId, isPageReady, type PageId } from "@/panels/pages";

function readPageFromUrl(): PageId | null {
	if (typeof window === "undefined") return null;
	const raw = new URLSearchParams(window.location.search).get("page");
	if (!raw || !isPageId(raw) || !isPageReady({ page: raw })) return null;
	return raw;
}

/**
 * Two-way binding between the active page and the URL / per-project memory
 * (UX-005), active only while the pages-shell flag is on:
 *   - on project open, restore the page from `?page=` (deep link) or the last
 *     page used for that project;
 *   - mirror later switches back into `?page=` and the per-project memory.
 * The page bar / shortcuts remain the source of truth — they call
 * `setActivePage`; this hook just persists and reflects the result.
 */
export function usePageDeepLink({ projectId }: { projectId: string }) {
	const pagesShellEnabled = useFlag("pages-shell");
	const activePage = usePageStore((state) => state.activePage);
	const setActivePage = usePageStore((state) => state.setActivePage);
	const rememberProjectPage = usePageStore((state) => state.rememberProjectPage);

	// Restore once per project (deep link wins over per-project memory).
	useEffect(() => {
		if (!pagesShellEnabled) return;
		const fromUrl = readPageFromUrl();
		const remembered = usePageStore.getState().lastByProject[projectId];
		const target =
			fromUrl ??
			(remembered && isPageReady({ page: remembered }) ? remembered : null);
		if (target) setActivePage({ page: target });
	}, [projectId, pagesShellEnabled, setActivePage]);

	// Reflect the active page into the URL + per-project memory.
	useEffect(() => {
		if (!pagesShellEnabled) return;
		rememberProjectPage({ projectId, page: activePage });
		if (typeof window === "undefined") return;
		const url = new URL(window.location.href);
		if (url.searchParams.get("page") !== activePage) {
			url.searchParams.set("page", activePage);
			window.history.replaceState(null, "", url);
		}
	}, [activePage, projectId, pagesShellEnabled, rememberProjectPage]);
}
