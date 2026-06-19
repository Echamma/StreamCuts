"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateUUID } from "@/utils/id";
import type { SocialLink } from "@/socials/types";

const DEFAULT_LINKS: SocialLink[] = [
	{ id: "tiktok", label: "TikTok", url: "" },
	{ id: "instagram", label: "Instagram", url: "" },
	{ id: "youtube", label: "YouTube", url: "" },
];

interface SocialsStore {
	about: string;
	links: SocialLink[];
	setAbout: (about: string) => void;
	updateLink: (args: { id: string; patch: Partial<SocialLink> }) => void;
	addLink: () => void;
	removeLink: (id: string) => void;
}

export const useSocialsStore = create<SocialsStore>()(
	persist(
		(set) => ({
			about: "",
			links: DEFAULT_LINKS,
			setAbout: (about) => set({ about }),
			updateLink: ({ id, patch }) =>
				set((state) => ({
					links: state.links.map((link) =>
						link.id === id ? { ...link, ...patch } : link,
					),
				})),
			addLink: () =>
				set((state) => ({
					links: [
						...state.links,
						{
							id: generateUUID(),
							label: "",
							url: "",
						},
					],
				})),
			removeLink: (id) =>
				set((state) => ({
					links: state.links.filter((link) => link.id !== id),
				})),
		}),
		{
			name: "opencut-socials",
		},
	),
);
