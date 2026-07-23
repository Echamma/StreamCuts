"use client";

import {
	DropdownMenuCheckboxItem,
	DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { FLAG_IDS, FLAG_META, useFlag, useFlagStore, type FlagId } from "@/flags";

/**
 * Renders a labelled "Experiments" section of flag toggles, intended to sit
 * inside a DropdownMenuContent. This is the interim home for the pages-shell
 * toggle until the dedicated Settings surface (UX-007) exists.
 */
export function FlagsMenuItems() {
	return (
		<>
			<DropdownMenuLabel>Experiments</DropdownMenuLabel>
			{FLAG_IDS.map((id) => (
				<FlagCheckboxItem key={id} id={id} />
			))}
		</>
	);
}

function FlagCheckboxItem({ id }: { id: FlagId }) {
	const enabled = useFlag(id);
	const setFlag = useFlagStore((state) => state.setFlag);
	const meta = FLAG_META[id];

	return (
		<DropdownMenuCheckboxItem
			checked={enabled}
			onCheckedChange={(checked) => setFlag({ id, enabled: checked })}
			onSelect={(event) => event.preventDefault()}
			title={meta.description}
		>
			{meta.label}
		</DropdownMenuCheckboxItem>
	);
}
