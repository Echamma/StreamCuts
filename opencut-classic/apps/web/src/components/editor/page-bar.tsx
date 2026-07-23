"use client";

import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";
import { usePageStore } from "@/editor/page-store";
import { PAGE_ORDER, PAGE_META, type PageId } from "@/panels/pages";

/**
 * DaVinci-style page bar (UX-001): a bottom-anchored tablist that switches the
 * active workspace page. Not-ready pages render disabled — they mark where a
 * page will live without shipping an empty one. Rendered only when the
 * pages-shell flag is on (see the editor route).
 */
export function PageBar() {
	const activePage = usePageStore((state) => state.activePage);
	const setActivePage = usePageStore((state) => state.setActivePage);
	const tabRefs = useRef<Partial<Record<PageId, HTMLButtonElement | null>>>({});

	const readyPages = PAGE_ORDER.filter((page) => PAGE_META[page].ready);

	const focusPage = ({ page }: { page: PageId }) => {
		setActivePage({ page });
		tabRefs.current[page]?.focus();
	};

	// Roving arrow-key navigation across the ready tabs only (WAI-ARIA tablist,
	// automatic activation).
	const handleKeyDown = ({
		event,
		page,
	}: {
		event: React.KeyboardEvent;
		page: PageId;
	}) => {
		if (readyPages.length === 0) return;
		const index = readyPages.indexOf(page);
		let nextIndex: number | null = null;
		switch (event.key) {
			case "ArrowRight":
			case "ArrowDown":
				nextIndex = (index + 1) % readyPages.length;
				break;
			case "ArrowLeft":
			case "ArrowUp":
				nextIndex = (index - 1 + readyPages.length) % readyPages.length;
				break;
			case "Home":
				nextIndex = 0;
				break;
			case "End":
				nextIndex = readyPages.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		const nextPage = readyPages[nextIndex];
		if (nextPage) focusPage({ page: nextPage });
	};

	return (
		<div
			role="tablist"
			aria-label="Workspace pages"
			aria-orientation="horizontal"
			className="bg-background flex h-10 shrink-0 items-center justify-center gap-1 border-t px-3"
		>
			{PAGE_ORDER.map((page) => {
				const meta = PAGE_META[page];
				const isActive = activePage === page;
				const isDisabled = !meta.ready;
				return (
					<button
						key={page}
						type="button"
						role="tab"
						aria-selected={isActive}
						aria-disabled={isDisabled}
						disabled={isDisabled}
						title={isDisabled ? `${meta.label} — coming soon` : meta.label}
						tabIndex={isActive && !isDisabled ? 0 : -1}
						ref={(node) => {
							tabRefs.current[page] = node;
						}}
						onClick={() => {
							if (!isDisabled) setActivePage({ page });
						}}
						onKeyDown={(event) => handleKeyDown({ event, page })}
						className={cn(
							"flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
							isActive
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:text-foreground hover:bg-accent",
							isDisabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
						)}
					>
						<HugeiconsIcon icon={meta.icon} className="size-4" />
						<span>{meta.label}</span>
					</button>
				);
			})}
		</div>
	);
}
