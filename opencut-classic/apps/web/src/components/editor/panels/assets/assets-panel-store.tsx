import type { ElementType } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	ArrowRightDoubleIcon,
	Bookmark02Icon,
	Briefcase09Icon,
	ClosedCaptionIcon,
	Folder03Icon,
	Happy01Icon,
	HeadphonesIcon,
	MagicWand05Icon,
	Share08Icon,
	SlidersHorizontalIcon,
	Settings01Icon,
	TextIcon,
	Video01Icon,
	VideoReplayIcon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export const TAB_KEYS = [
	"media",
	"sounds",
	"audio-mixer",
	"text",
	"stickers",
	"effects",
	"transitions",
	"captions",
	"markers",
	"adjustment",
	"boss",
	"summarize",
	"long-to-short",
	"socials",
	"settings",
] as const;

export type Tab = (typeof TAB_KEYS)[number];

const createHugeiconsIcon =
	({ icon }: { icon: IconSvgElement }) => {
		const IconComponent = ({ className }: { className?: string }) => (
			<HugeiconsIcon icon={icon} className={className} />
		);
		IconComponent.displayName = "AssetsPanelIcon";
		return IconComponent;
	};

export const tabs = {
	media: {
		icon: createHugeiconsIcon({ icon: Folder03Icon }),
		label: "Media",
	},
	sounds: {
		icon: createHugeiconsIcon({ icon: HeadphonesIcon }),
		label: "Sounds",
	},
	"audio-mixer": {
		icon: createHugeiconsIcon({ icon: VolumeHighIcon }),
		label: "Audio",
	},
	text: {
		icon: createHugeiconsIcon({ icon: TextIcon }),
		label: "Text",
	},
	stickers: {
		icon: createHugeiconsIcon({ icon: Happy01Icon }),
		label: "Stickers",
	},
	effects: {
		icon: createHugeiconsIcon({ icon: MagicWand05Icon }),
		label: "Effects",
	},
	transitions: {
		icon: createHugeiconsIcon({ icon: ArrowRightDoubleIcon }),
		label: "Transitions",
	},
	captions: {
		icon: createHugeiconsIcon({ icon: ClosedCaptionIcon }),
		label: "Captions",
	},
	markers: {
		icon: createHugeiconsIcon({ icon: Bookmark02Icon }),
		label: "Markers",
	},
	adjustment: {
		icon: createHugeiconsIcon({ icon: SlidersHorizontalIcon }),
		label: "Adjustment",
	},
	boss: {
		icon: createHugeiconsIcon({ icon: Briefcase09Icon }),
		label: "Boss",
	},
	summarize: {
		icon: createHugeiconsIcon({ icon: VideoReplayIcon }),
		label: "Summarize",
	},
	"long-to-short": {
		icon: createHugeiconsIcon({ icon: Video01Icon }),
		label: "Long to Short",
	},
	socials: {
		icon: createHugeiconsIcon({ icon: Share08Icon }),
		label: "Socials",
	},
	settings: {
		icon: createHugeiconsIcon({ icon: Settings01Icon }),
		label: "Settings",
	},
} satisfies Record<
	Tab,
	{ icon: ElementType<{ className?: string }>; label: string }
>;

export type MediaViewMode = "grid" | "list";
export type MediaSortKey = "name" | "type" | "duration" | "size";
export type MediaSortOrder = "asc" | "desc";

export interface MediaFolder {
	id: string;
	name: string;
}

/** A saved media search (MED-002). `query` is the search text applied when the
 * bin is opened; matching itself runs through the tested `matchesMediaQuery`. */
export interface SmartBin {
	id: string;
	name: string;
	query: string;
}

interface AssetsPanelStore {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	highlightMediaId: string | null;
	requestRevealMedia: (mediaId: string) => void;
	clearHighlight: () => void;

	/* Media */
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	mediaSortBy: MediaSortKey;
	mediaSortOrder: MediaSortOrder;
	setMediaSort: (args: { key: MediaSortKey; order: MediaSortOrder }) => void;

	/* Folders */
	folders: MediaFolder[];
	currentFolderId: string | null;
	createFolder: (name: string) => string;
	renameFolder: (id: string, name: string) => void;
	deleteFolder: (id: string) => void;
	setCurrentFolder: (id: string | null) => void;

	/* Smart bins (saved searches) */
	smartBins: SmartBin[];
	createSmartBin: (args: { name: string; query: string }) => void;
	deleteSmartBin: (id: string) => void;
}

export const useAssetsPanelStore = create<AssetsPanelStore>()(
	persist(
		(set, get) => ({
			activeTab: "media",
			setActiveTab: (tab) => set({ activeTab: tab }),
			highlightMediaId: null,
			requestRevealMedia: (mediaId) =>
				set({ activeTab: "media", highlightMediaId: mediaId }),
			clearHighlight: () => set({ highlightMediaId: null }),
			mediaViewMode: "grid",
			setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
			mediaSortBy: "name",
			mediaSortOrder: "asc",
			setMediaSort: ({ key, order }) =>
				set({ mediaSortBy: key, mediaSortOrder: order }),
			folders: [],
			currentFolderId: null,
			createFolder: (name) => {
				const id = crypto.randomUUID();
				set((state) => ({ folders: [...state.folders, { id, name }] }));
				return id;
			},
			renameFolder: (id, name) =>
				set((state) => ({
					folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f)),
				})),
			deleteFolder: (id) =>
				set((state) => ({
					folders: state.folders.filter((f) => f.id !== id),
					currentFolderId: state.currentFolderId === id ? null : state.currentFolderId,
				})),
			setCurrentFolder: (id) => set({ currentFolderId: id }),
			smartBins: [],
			createSmartBin: ({ name, query }) =>
				set((state) => ({
					smartBins: [
						...state.smartBins,
						{ id: crypto.randomUUID(), name, query },
					],
				})),
			deleteSmartBin: (id) =>
				set((state) => ({
					smartBins: state.smartBins.filter((bin) => bin.id !== id),
				})),
		}),
		{
			name: "assets-panel",
			partialize: (state) => ({
				mediaViewMode: state.mediaViewMode,
				mediaSortBy: state.mediaSortBy,
				mediaSortOrder: state.mediaSortOrder,
				folders: state.folders,
				smartBins: state.smartBins,
			}),
		},
	),
);
