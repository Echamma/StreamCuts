import type { IconSvgElement } from "@hugeicons/react";
import {
	AudioWave01Icon,
	CloudUploadIcon,
	Folder01Icon,
	RainDropIcon,
	ScissorIcon,
} from "@hugeicons/core-free-icons";
import type { ShortcutKey } from "@/actions/keybinding";

/**
 * The DaVinci-style page set (UX-001). Pages are layout presets over the single
 * shared editor state — switching a page is a pure view change, never a
 * document-state fork. Cut is intentionally absent; Fusion is reserved for once
 * FUS-001 ships.
 *
 * `ready` gates a page from the page bar and its switch shortcut: an unfinished
 * page ships nothing, per the roadmap's "an empty page ships nothing" rule.
 * Edit is the current workspace verbatim, so it is the only ready page today.
 */
export const PAGE_IDS = [
	"media",
	"edit",
	"color",
	"audio",
	"deliver",
] as const;

export type PageId = (typeof PAGE_IDS)[number];

const PAGE_ID_SET: ReadonlySet<string> = new Set(PAGE_IDS);

// Plain parameter (not an object param): a type predicate cannot reference a
// binding-pattern element, matching the repo's other guards (e.g. isKey).
export function isPageId(value: string): value is PageId {
	return PAGE_ID_SET.has(value);
}

export interface PageMeta {
	id: PageId;
	label: string;
	icon: IconSvgElement;
	/** Switch shortcut (also the default keybinding registered as an action). */
	shortcut: ShortcutKey;
	/** Whether the page is finished enough to expose. */
	ready: boolean;
}

export const PAGE_META: Record<PageId, PageMeta> = {
	media: {
		id: "media",
		label: "Media",
		icon: Folder01Icon,
		shortcut: "shift+1",
		ready: true,
	},
	edit: {
		id: "edit",
		label: "Edit",
		icon: ScissorIcon,
		shortcut: "shift+2",
		ready: true,
	},
	color: {
		id: "color",
		label: "Color",
		icon: RainDropIcon,
		shortcut: "shift+3",
		ready: true,
	},
	audio: {
		id: "audio",
		label: "Audio",
		icon: AudioWave01Icon,
		shortcut: "shift+4",
		ready: true,
	},
	deliver: {
		id: "deliver",
		label: "Deliver",
		icon: CloudUploadIcon,
		shortcut: "shift+5",
		ready: true,
	},
};

/** Page bar / shortcut order — matches Resolve (Media…Deliver). */
export const PAGE_ORDER: readonly PageId[] = PAGE_IDS;

/** The page shown when no other is active, and the safe fallback target. */
export const DEFAULT_PAGE: PageId = "edit";

export function isPageReady({ page }: { page: PageId }): boolean {
	return PAGE_META[page].ready;
}
