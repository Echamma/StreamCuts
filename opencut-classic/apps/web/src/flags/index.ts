import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Lightweight feature-flag registry. Flags default off and are flipped from
 * client state (persisted to localStorage), so a flag can gate an in-progress
 * feature without an env rebuild. Add an entry to FLAG_META to introduce one.
 */
export const FLAG_IDS = ["pages-shell"] as const;
export type FlagId = (typeof FLAG_IDS)[number];

interface FlagMeta {
	label: string;
	description: string;
	/** Value used when the user has never toggled the flag. */
	defaultValue: boolean;
}

export const FLAG_META: Record<FlagId, FlagMeta> = {
	"pages-shell": {
		label: "Pages workspace",
		description:
			"DaVinci-style Media/Edit/Color/Audio/Deliver pages instead of the single workspace.",
		defaultValue: false,
	},
};

interface FlagState {
	/** Only holds flags the user has explicitly toggled; others fall back to meta. */
	overrides: Partial<Record<FlagId, boolean>>;
	setFlag: (args: { id: FlagId; enabled: boolean }) => void;
	resetFlag: (args: { id: FlagId }) => void;
}

export const useFlagStore = create<FlagState>()(
	persist(
		(set) => ({
			overrides: {},
			setFlag: ({ id, enabled }) =>
				set((state) => ({
					overrides: { ...state.overrides, [id]: enabled },
				})),
			resetFlag: ({ id }) =>
				set((state) => {
					const { [id]: _removed, ...rest } = state.overrides;
					return { overrides: rest };
				}),
		}),
		{
			name: "feature-flags",
			version: 1,
			partialize: (state) => ({ overrides: state.overrides }),
		},
	),
);

function resolveFlag({
	id,
	overrides,
}: {
	id: FlagId;
	overrides: Partial<Record<FlagId, boolean>>;
}): boolean {
	return overrides[id] ?? FLAG_META[id].defaultValue;
}

/** React hook — re-renders when the flag changes. */
export function useFlag(id: FlagId): boolean {
	return useFlagStore((state) => resolveFlag({ id, overrides: state.overrides }));
}

/** Imperative read for use outside React (action handlers, guards). */
export function isFlagEnabled(id: FlagId): boolean {
	return resolveFlag({ id, overrides: useFlagStore.getState().overrides });
}
