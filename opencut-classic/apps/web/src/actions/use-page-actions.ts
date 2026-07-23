"use client";

import { useActionHandler } from "@/actions/use-action-handler";
import { usePageStore } from "@/editor/page-store";
import { isFlagEnabled } from "@/flags";
import type { PageId } from "@/panels/pages";

/**
 * Registers the Shift+1…Shift+5 page-switch handlers (UX-004). Switching is a
 * no-op while the pages-shell flag is off or the target page isn't ready — the
 * page store enforces the readiness gate, we add the flag gate here so the
 * shortcut does nothing until the shell is turned on.
 */
export function usePageActions() {
	const switchTo = (page: PageId) => () => {
		if (!isFlagEnabled("pages-shell")) return;
		usePageStore.getState().setActivePage({ page });
	};

	useActionHandler("switch-page-media", switchTo("media"), undefined);
	useActionHandler("switch-page-edit", switchTo("edit"), undefined);
	useActionHandler("switch-page-color", switchTo("color"), undefined);
	useActionHandler("switch-page-audio", switchTo("audio"), undefined);
	useActionHandler("switch-page-deliver", switchTo("deliver"), undefined);
}
