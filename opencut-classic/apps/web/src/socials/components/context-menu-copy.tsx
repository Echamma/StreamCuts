import {
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { SocialCopy } from "@/socials/types";

export function SocialCopyContextMenuSection({
	socialCopy,
	onCopyTitle,
	onCopyDescription,
}: {
	socialCopy: SocialCopy;
	onCopyTitle: () => void;
	onCopyDescription: () => void;
}) {
	return (
		<>
			<ContextMenuLabel className="pb-0">TikTok copy</ContextMenuLabel>
			<div className="px-3 pt-1 pb-2 text-xs">
				<p className="font-medium text-foreground">Title</p>
				<p className="mt-1 break-words whitespace-normal text-muted-foreground">
					{socialCopy.title}
				</p>
				<p className="mt-3 font-medium text-foreground">Description</p>
				<p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
					{socialCopy.description}
				</p>
				<p className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground">
					{socialCopy.provider === "gemini"
						? "Gemini suggestion"
						: "Fallback suggestion"}
				</p>
			</div>
			<ContextMenuItem onClick={onCopyTitle}>Copy title</ContextMenuItem>
			<ContextMenuItem onClick={onCopyDescription} textRight="+ BIO">
				Copy description
			</ContextMenuItem>
			<ContextMenuSeparator />
		</>
	);
}
