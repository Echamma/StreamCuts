"use client";

import { useState } from "react";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Briefcase09Icon } from "@hugeicons/core-free-icons";
import { BossPanel } from "@/components/editor/panels/boss";
import { useFlag } from "@/flags";

/**
 * Boss as a global right-edge drawer (UX-006). In the pages shell the Boss AI
 * job surface no longer lives as a left-rail tab — it's reachable from every
 * page here, and its job state persists across page switches because BossPanel
 * reads the shared boss store. Flag-gated: hidden until the shell is on.
 */
export function BossDrawer() {
	const pagesShellEnabled = useFlag("pages-shell");
	const [open, setOpen] = useState(false);

	if (!pagesShellEnabled) return null;

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5">
					<HugeiconsIcon icon={Briefcase09Icon} className="size-4" />
					Boss
				</Button>
			</SheetTrigger>
			<SheetContent
				side="right"
				className="flex w-[420px] flex-col p-0 sm:max-w-[420px]"
			>
				<SheetHeader className="h-11 shrink-0 justify-center border-b px-4">
					<SheetTitle className="text-sm">Boss</SheetTitle>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-hidden">
					<BossPanel />
				</div>
			</SheetContent>
		</Sheet>
	);
}
