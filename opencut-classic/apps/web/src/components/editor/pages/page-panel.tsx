import type { ReactNode } from "react";
import { cn } from "@/utils/ui";

/**
 * Standard panel chrome for a page slot that hosts a raw assets *view*
 * (MediaView, AudioMixerView, …). Those views expect the `panel` CSS scope +
 * border/rounding that AssetsPanel normally provides; page layouts reuse them
 * standalone, so this supplies the same wrapper. Self-wrapping panels
 * (PreviewPanel, PropertiesPanel) don't need it.
 */
export function PagePanel({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"panel bg-background flex h-full flex-col overflow-hidden rounded-sm border",
				className,
			)}
		>
			{children}
		</div>
	);
}
