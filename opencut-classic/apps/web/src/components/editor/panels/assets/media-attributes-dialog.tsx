"use client";

import { useEditor } from "@/editor/use-editor";
import { addTag, MAX_RATING, removeTag } from "@/media/metadata";
import type { MediaAsset } from "@/media/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ClipAttributes } from "@/services/storage/types";
import { cn } from "@/utils/ui";
import { useState } from "react";

/**
 * Editor for a media asset's tags / notes / rating (MED-003). Save routes
 * through `editor.media.updateAssetAttributes`, which normalises and persists
 * (an all-empty set clears the attributes).
 *
 * The form body is an inner component mounted only while the dialog is open (and
 * keyed by asset id), so its `useState` initialisers seed straight from the
 * asset with no effect — reopening or switching assets remounts it fresh.
 */
export function MediaAttributesDialog({
	asset,
	projectId,
	open,
	onOpenChange,
}: {
	asset: MediaAsset;
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-96">
				<DialogHeader>
					<DialogTitle>Clip attributes</DialogTitle>
				</DialogHeader>
				{open && (
					<AttributesForm
						key={asset.id}
						asset={asset}
						projectId={projectId}
						onClose={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function AttributesForm({
	asset,
	projectId,
	onClose,
}: {
	asset: MediaAsset;
	projectId: string;
	onClose: () => void;
}) {
	const editor = useEditor();
	const [rating, setRating] = useState(asset.attributes?.rating ?? 0);
	const [tags, setTags] = useState<string[]>(asset.attributes?.tags ?? []);
	const [notes, setNotes] = useState(asset.attributes?.notes ?? "");
	const [tagDraft, setTagDraft] = useState("");

	const commitTagDraft = () => {
		const draft = tagDraft.trim();
		if (draft === "") {
			return;
		}
		setTags((current) => addTag({ attributes: { tags: current }, tag: draft }).tags ?? []);
		setTagDraft("");
	};

	const handleSave = () => {
		const attributes: ClipAttributes = { rating, tags, notes };
		void editor.media.updateAssetAttributes({
			projectId,
			assetId: asset.id,
			attributes,
		});
		onClose();
	};

	return (
		<>
			<DialogBody className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<span className="text-xs text-muted-foreground">Rating</span>
						<div className="flex items-center gap-1">
							{Array.from({ length: MAX_RATING }, (_, index) => index + 1).map(
								(star) => (
									<button
										key={star}
										type="button"
										aria-label={`${star} star${star > 1 ? "s" : ""}`}
										aria-pressed={star <= rating}
										className={cn(
											"text-lg leading-none transition-colors",
											star <= rating
												? "text-primary"
												: "text-muted-foreground/40 hover:text-muted-foreground",
										)}
										onClick={() => setRating(star === rating ? 0 : star)}
									>
										{star <= rating ? "★" : "☆"}
									</button>
								),
							)}
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-xs text-muted-foreground">Tags</span>
						{tags.length > 0 && (
							<div className="flex flex-wrap gap-1.5">
								{tags.map((tag) => (
									<Badge
										key={tag}
										variant="secondary"
										className="gap-1 pr-1"
									>
										{tag}
										<button
											type="button"
											aria-label={`Remove ${tag}`}
											className="rounded-sm px-1 text-muted-foreground hover:text-foreground"
											onClick={() =>
												setTags(
													(current) =>
														removeTag({ attributes: { tags: current }, tag }).tags ??
														[],
												)
											}
										>
											{"×"}
										</button>
									</Badge>
								))}
							</div>
						)}
						<Input
							value={tagDraft}
							placeholder="Add a tag and press Enter"
							onChange={(event) => setTagDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									commitTagDraft();
								}
							}}
							onBlur={commitTagDraft}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-xs text-muted-foreground">Notes</span>
						<Textarea
							value={notes}
							rows={3}
							placeholder="Notes about this clip"
							onChange={(event) => setNotes(event.target.value)}
						/>
					</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button onClick={handleSave}>Save</Button>
			</DialogFooter>
		</>
	);
}
