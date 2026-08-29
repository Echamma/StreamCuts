"use client";

import Image from "next/image";
import { useCallback, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { type MediaTime } from "@/wasm";
import { useEditor } from "@/editor/use-editor";
import { useFileUpload } from "@/media/use-file-upload";
import { invokeAction } from "@/actions";
import { processMediaAssets } from "@/media/processing";
import { MediaAttributesDialog } from "@/components/editor/panels/assets/media-attributes-dialog";
import {
	requestProRes,
	requestProxy,
	transcodeOutputUrl,
} from "@/services/transcode/api";
import { showMediaUploadToast } from "@/media/upload-toast";
import { buildSocialDescriptionClipboardText } from "@/socials/copy";
import { SocialCopyContextMenuSection } from "@/socials/components/context-menu-copy";
import { useSocialsStore } from "@/socials/store";
import {
	SelectableItem,
	SelectableSurface,
	useSelection,
	useSelectionScope,
} from "@/selection";
import {
	type MediaFolder,
	type MediaSortKey,
	type MediaSortOrder,
	type MediaViewMode,
	useAssetsPanelStore,
} from "@/components/editor/panels/assets/assets-panel-store";
import { MASKABLE_ELEMENT_TYPES } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { cn } from "@/utils/ui";
import { buildElementFromAsset, isSubclipAsset } from "@/media/asset-source";
import {
	ArrowLeft01Icon,
	Cancel01Icon,
	CloudUploadIcon,
	FolderAddIcon,
	Folder01Icon,
	GridViewIcon,
	LeftToRightListDashIcon,
	Search01Icon,
	SortingOneNineIcon,
	Image02Icon,
	MusicNote03Icon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { matchesMediaQuery } from "@/media/metadata";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function MediaView() {
	const editor = useEditor();
	const [showAllScenes, setShowAllScenes] = useState(false);
	const allMediaFiles = useEditor((e) => e.media.getAssets());
	const activeScene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const activeProject = useEditor((e) => e.project.getActive());

	const mediaFiles = useMemo(() => {
		if (showAllScenes || !activeScene) return allMediaFiles;
		return allMediaFiles.filter(
			(a) => a.sceneId === activeScene.id || a.sceneId == null,
		);
	}, [allMediaFiles, activeScene, showAllScenes]);

	const {
		mediaViewMode,
		setMediaViewMode,
		highlightMediaId,
		clearHighlight,
		mediaSortBy,
		mediaSortOrder,
		setMediaSort,
		folders,
		currentFolderId,
		createFolder,
		renameFolder,
		deleteFolder,
		setCurrentFolder,
		smartBins,
		createSmartBin,
		deleteSmartBin,
	} = useAssetsPanelStore();

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);
	const [isCreatingFolder, setIsCreatingFolder] = useState(false);
	const [newFolderName, setNewFolderName] = useState("New Folder");
	const newFolderInputRef = useRef<HTMLInputElement>(null);
	const [searchText, setSearchText] = useState("");
	const trimmedSearch = searchText.trim();
	const hasQuery = trimmedSearch !== "";

	const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;

	const processFiles = async ({ files }: { files: File[] }) => {
		if (!files || files.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		try {
			await showMediaUploadToast({
				filesCount: files.length,
				promise: async () => {
					const processedAssets = await processMediaAssets({
						files,
						onProgress: (progress: { progress: number }) =>
							setProgress(progress.progress),
					});
					for (const asset of processedAssets) {
						if (!showAllScenes && activeScene) {
							await editor.media.addMediaAssetToScene({
								projectId: activeProject.metadata.id,
								sceneId: activeScene.id,
								asset: { ...asset, folderId: currentFolderId },
							});
						} else {
							await editor.media.addMediaAsset({
								projectId: activeProject.metadata.id,
								asset: { ...asset, folderId: currentFolderId },
							});
						}
					}
					return {
						uploadedCount: processedAssets.length,
						assetNames: processedAssets.map((asset) => asset.name),
					};
				},
			});
		} catch (error) {
			console.error("Error processing files:", error);
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const { isDragOver, dragProps, openFilePicker, fileInputProps } =
		useFileUpload({
			accept: "image/*,video/*,audio/*",
			multiple: true,
			onFilesSelected: (files) => processFiles({ files }),
		});

	const handleRemove = ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => {
		event.stopPropagation();
		invokeAction("remove-media-assets", {
			projectId: activeProject.metadata.id,
			assetIds: ids,
		});
	};

	const handleMoveToFolder = useCallback(
		async (assetId: string, targetFolderId: string | null) => {
			if (!activeProject) return;
			await editor.media.moveAssetToFolder({
				projectId: activeProject.metadata.id,
				assetId,
				folderId: targetFolderId,
			});
		},
		[editor, activeProject],
	);

	const handleSort = ({ key }: { key: MediaSortKey }) => {
		if (mediaSortBy === key) {
			setMediaSort({ key, order: mediaSortOrder === "asc" ? "desc" : "asc" });
		} else {
			setMediaSort({ key, order: "asc" });
		}
	};

	const handleStartCreateFolder = () => {
		setNewFolderName("New Folder");
		setIsCreatingFolder(true);
		setTimeout(() => newFolderInputRef.current?.select(), 0);
	};

	const handleConfirmCreateFolder = () => {
		const trimmed = newFolderName.trim();
		if (trimmed) {
			createFolder(trimmed);
		}
		setIsCreatingFolder(false);
	};

	const handleDeleteFolder = (folderId: string) => {
		const assetsInFolder = mediaFiles.filter((a) => a.folderId === folderId);
		for (const asset of assetsInFolder) {
			void editor.media.moveAssetToFolder({
				projectId: activeProject.metadata.id,
				assetId: asset.id,
				folderId: null,
			});
		}
		deleteFolder(folderId);
	};

	const handleRenameFolder = (folderId: string) => {
		const folder = folders.find((f) => f.id === folderId);
		if (!folder) return;
		const name = window.prompt("Rename folder:", folder.name);
		if (name?.trim()) {
			renameFolder(folderId, name.trim());
		}
	};

	const sortedMediaItems = useMemo(() => {
		const filtered = mediaFiles.filter((item) => !item.ephemeral);
		filtered.sort((a, b) => {
			let valueA: string | number;
			let valueB: string | number;
			switch (mediaSortBy) {
				case "name":
					valueA = a.name.toLowerCase();
					valueB = b.name.toLowerCase();
					break;
				case "type":
					valueA = a.type;
					valueB = b.type;
					break;
				case "duration":
					valueA = a.duration || 0;
					valueB = b.duration || 0;
					break;
				case "size":
					valueA = a.size;
					valueB = b.size;
					break;
				default:
					return 0;
			}
			if (valueA < valueB) return mediaSortOrder === "asc" ? -1 : 1;
			if (valueA > valueB) return mediaSortOrder === "asc" ? 1 : -1;
			return 0;
		});
		return filtered;
	}, [mediaFiles, mediaSortBy, mediaSortOrder]);

	const visibleAssets = useMemo(() => {
		// An active search spans every folder; otherwise scope to the open folder.
		if (hasQuery) {
			return sortedMediaItems.filter((item) =>
				matchesMediaQuery({ asset: item, query: { text: trimmedSearch } }),
			);
		}
		return sortedMediaItems.filter((item) =>
			currentFolderId === null
				? !item.folderId
				: item.folderId === currentFolderId,
		);
	}, [sortedMediaItems, currentFolderId, hasQuery, trimmedSearch]);

	const orderedMediaIds = useMemo(
		() => visibleAssets.map((item) => item.id),
		[visibleAssets],
	);

	// While searching we never show the drag-to-import overlay — an empty result
	// set gets a "no matches" hint instead.
	const isEmpty =
		!hasQuery &&
		(currentFolderId === null
			? folders.length === 0 && visibleAssets.length === 0 && !isCreatingFolder
			: visibleAssets.length === 0);

	return (
		<>
			<input {...fileInputProps} />

			<PanelView
				title={currentFolder ? currentFolder.name : "Assets"}
				actions={
					<MediaActions
						mediaViewMode={mediaViewMode}
						setMediaViewMode={setMediaViewMode}
						isProcessing={isProcessing}
						sortBy={mediaSortBy}
						sortOrder={mediaSortOrder}
						onSort={handleSort}
						onImport={openFilePicker}
						onNewFolder={currentFolderId === null ? handleStartCreateFolder : undefined}
						showAllScenes={showAllScenes}
						onToggleAllScenes={() => setShowAllScenes((v) => !v)}
					/>
				}
				className={cn(isDragOver && "bg-accent/30")}
				contentClassName="h-full"
				{...dragProps}
			>
				<div className="mb-3 flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<div className="relative flex-1">
							<HugeiconsIcon
								icon={Search01Icon}
								className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
							/>
							<Input
								value={searchText}
								onChange={(event) => setSearchText(event.target.value)}
								placeholder="Search name, tags, notes…"
								aria-label="Search media"
								className="h-8 px-8 text-xs"
							/>
							{searchText !== "" && (
								<button
									type="button"
									aria-label="Clear search"
									onClick={() => setSearchText("")}
									className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 transition-colors"
								>
									<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
								</button>
							)}
						</div>
						{hasQuery && (
							<Button
								size="sm"
								variant="outline"
								className="h-8 shrink-0 text-xs"
								onClick={() => {
									createSmartBin({ name: trimmedSearch, query: trimmedSearch });
									toast.success(`Saved smart bin “${trimmedSearch}”.`);
								}}
							>
								Save bin
							</Button>
						)}
					</div>

					{!hasQuery && smartBins.length > 0 && (
						<div className="flex flex-wrap gap-1.5">
							{smartBins.map((bin) => (
								<span
									key={bin.id}
									className="border-border bg-muted/40 text-muted-foreground flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
								>
									<button
										type="button"
										className="hover:text-foreground max-w-32 truncate transition-colors"
										onClick={() => setSearchText(bin.query)}
									>
										{bin.name}
									</button>
									<button
										type="button"
										aria-label={`Delete smart bin ${bin.name}`}
										className="hover:text-foreground rounded-full px-0.5 transition-colors"
										onClick={() => deleteSmartBin(bin.id)}
									>
										<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
									</button>
								</span>
							))}
						</div>
					)}
				</div>

				{hasQuery && visibleAssets.length === 0 ? (
					<p className="text-muted-foreground py-6 text-center text-xs">
						No media matches “{searchText}”.
					</p>
				) : null}

				{currentFolder && !hasQuery ? (
					<button
						type="button"
						onClick={() => setCurrentFolder(null)}
						className="text-muted-foreground hover:text-foreground mb-3 flex items-center gap-1.5 text-xs transition-colors"
					>
						<HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
						All Media
					</button>
				) : null}

				{isDragOver || isEmpty ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						onClick={openFilePicker}
					/>
				) : (
					<SelectableSurface
						ariaLabel="Assets"
						orderedIds={orderedMediaIds}
						revealId={highlightMediaId}
						onRevealComplete={clearHighlight}
					>
						<MediaScopeRegistrar />

						{currentFolderId === null && !hasQuery ? (
							<>
								{(folders.length > 0 || isCreatingFolder) && (
									<div className="mb-4">
										<FolderList
											folders={folders}
											mode={mediaViewMode}
											isCreatingFolder={isCreatingFolder}
											newFolderName={newFolderName}
											newFolderInputRef={newFolderInputRef}
											onNewFolderNameChange={setNewFolderName}
											onConfirmCreate={handleConfirmCreateFolder}
											onCancelCreate={() => setIsCreatingFolder(false)}
											onOpenFolder={setCurrentFolder}
											onRenameFolder={handleRenameFolder}
											onDeleteFolder={handleDeleteFolder}
										/>
									</div>
								)}

								{isCreatingFolder && folders.length === 0 && (
									<div className="mb-4">
										<FolderList
											folders={[]}
											mode={mediaViewMode}
											isCreatingFolder={isCreatingFolder}
											newFolderName={newFolderName}
											newFolderInputRef={newFolderInputRef}
											onNewFolderNameChange={setNewFolderName}
											onConfirmCreate={handleConfirmCreateFolder}
											onCancelCreate={() => setIsCreatingFolder(false)}
											onOpenFolder={setCurrentFolder}
											onRenameFolder={handleRenameFolder}
											onDeleteFolder={handleDeleteFolder}
										/>
									</div>
								)}
							</>
						) : null}

						{visibleAssets.length > 0 ? (
							<MediaItemList
								items={visibleAssets}
								mode={mediaViewMode}
								folders={folders}
								currentFolderId={currentFolderId}
								onRemove={handleRemove}
								onMoveToFolder={handleMoveToFolder}
								activeSceneId={activeScene?.id ?? null}
								projectId={activeProject?.metadata.id ?? ""}
							/>
						) : null}
					</SelectableSurface>
				)}
			</PanelView>
		</>
	);
}

function MediaScopeRegistrar() {
	useSelectionScope();
	return null;
}

function FolderList({
	folders,
	mode,
	isCreatingFolder,
	newFolderName,
	newFolderInputRef,
	onNewFolderNameChange,
	onConfirmCreate,
	onCancelCreate,
	onOpenFolder,
	onRenameFolder,
	onDeleteFolder,
}: {
	folders: MediaFolder[];
	mode: MediaViewMode;
	isCreatingFolder: boolean;
	newFolderName: string;
	newFolderInputRef: React.RefObject<HTMLInputElement | null>;
	onNewFolderNameChange: (name: string) => void;
	onConfirmCreate: () => void;
	onCancelCreate: () => void;
	onOpenFolder: (id: string) => void;
	onRenameFolder: (id: string) => void;
	onDeleteFolder: (id: string) => void;
}) {
	const isGrid = mode === "grid";

	return (
		<div
			className={cn(isGrid ? "grid gap-4" : "flex flex-col gap-1.5")}
			style={
				isGrid ? { gridTemplateColumns: "repeat(auto-fill, 7rem)" } : undefined
			}
		>
			{folders.map((folder) => (
				<FolderItem
					key={folder.id}
					folder={folder}
					mode={mode}
					onOpen={() => onOpenFolder(folder.id)}
					onRename={() => onRenameFolder(folder.id)}
					onDelete={() => onDeleteFolder(folder.id)}
				/>
			))}
			{isCreatingFolder ? (
				<div
					className={cn(
						"flex items-center gap-2",
						isGrid
							? "h-28 w-28 flex-col justify-center rounded-md border bg-accent/30 p-2"
							: "rounded-md border bg-accent/30 px-3 py-2",
					)}
				>
					<HugeiconsIcon icon={Folder01Icon} className="size-5 shrink-0 text-muted-foreground" />
					<Input
						ref={newFolderInputRef}
						value={newFolderName}
						onChange={(e) => onNewFolderNameChange(e.currentTarget.value)}
						onBlur={onConfirmCreate}
						onKeyDown={(e) => {
							if (e.key === "Enter") onConfirmCreate();
							if (e.key === "Escape") onCancelCreate();
						}}
						className="h-6 px-1 py-0 text-xs"
						autoFocus
					/>
				</div>
			) : null}
		</div>
	);
}

function FolderItem({
	folder,
	mode,
	onOpen,
	onRename,
	onDelete,
}: {
	folder: MediaFolder;
	mode: MediaViewMode;
	onOpen: () => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const isGrid = mode === "grid";

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<button
					type="button"
					onClick={onOpen}
					className={cn(
						"group cursor-pointer text-left transition-colors",
						isGrid
							? "flex h-28 w-28 flex-col items-center justify-center gap-2 rounded-md border bg-accent/20 p-2 hover:bg-accent/40"
							: "flex items-center gap-3 rounded-md border bg-accent/20 px-3 py-2 hover:bg-accent/40",
					)}
				>
					<HugeiconsIcon
						icon={Folder01Icon}
						className={cn(
							"text-muted-foreground shrink-0",
							isGrid ? "size-8" : "size-4",
						)}
					/>
					<span
						className={cn(
							"truncate font-medium",
							isGrid ? "w-full text-center text-xs" : "text-sm",
						)}
					>
						{folder.name}
					</span>
				</button>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
				<ContextMenuItem variant="destructive" onClick={onDelete}>
					Delete folder
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function MediaAssetDraggable({
	item,
	preview,
	variant,
	isRounded,
}: {
	item: MediaAsset;
	preview: React.ReactNode;
	variant: "card" | "compact";
	isRounded?: boolean;
}) {
	const editor = useEditor();

	const addElementAtTime = ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: MediaTime;
	}) => {
		const element = buildElementFromAsset({
			asset,
			startTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<DraggableItem
			name={item.name}
			preview={preview}
			dragData={{
				id: item.id,
				type: "media",
				mediaType: item.type,
				name: item.name,
				...(item.type !== "audio" && {
					targetElementTypes: [...MASKABLE_ELEMENT_TYPES],
				}),
			}}
			shouldShowPlusOnDrag={false}
			onAddToTimeline={({ currentTime }) =>
				addElementAtTime({ asset: item, startTime: currentTime })
			}
			variant={variant}
			isRounded={isRounded}
		/>
	);
}

function MediaItemWithContextMenu({
	item,
	folders,
	currentFolderId: _currentFolderId,
	children,
	onRemove,
	onMoveToFolder,
	activeSceneId,
	projectId,
}: {
	item: MediaAsset;
	folders: MediaFolder[];
	currentFolderId: string | null;
	children: React.ReactNode;
	onRemove: ({ event, ids }: { event: React.MouseEvent; ids: string[] }) => void;
	onMoveToFolder: (assetId: string, folderId: string | null) => void;
	activeSceneId: string | null;
	projectId: string;
}) {
	const editor = useEditor();
	const { isSelected, selectedIds } = useSelection();
	const about = useSocialsStore((state) => state.about);
	const links = useSocialsStore((state) => state.links);
	const [attributesOpen, setAttributesOpen] = useState(false);
	const idsToDelete = isSelected(item.id) ? selectedIds : [item.id];
	const deleteLabel =
		idsToDelete.length > 1 ? `Delete ${idsToDelete.length} items` : "Delete";

	const handleMakeProjectWide = () => {
		if (!projectId) return;
		void editor.media.promoteAssetToProjectWide({ projectId, assetId: item.id });
	};

	const handleTranscode = async ({ kind }: { kind: "proxy" | "prores" }) => {
		const label = kind === "proxy" ? "H.264 proxy" : "ProRes";
		const toastId = toast.loading(`Transcoding ${item.name} to ${label}…`);
		try {
			const result =
				kind === "proxy"
					? await requestProxy({ file: item.file })
					: await requestProRes({ file: item.file, profile: "standard" });
			const anchor = document.createElement("a");
			anchor.href = transcodeOutputUrl({ fileName: result.fileName });
			anchor.download = result.fileName;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			toast.success(`${label} ready — downloading.`, { id: toastId });
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Transcode failed.",
				{ id: toastId },
			);
		}
	};

	/**
	 * Build an editing proxy and attach it to this asset, so preview scrubs the
	 * lightweight all-intra copy instead of the master. Export is unaffected —
	 * it always renders from the master.
	 */
	const handleGenerateProxy = async () => {
		if (!projectId) return;
		const toastId = toast.loading(
			`Building editing proxy for ${item.name}… this runs once.`,
		);
		try {
			const result = await requestProxy({ file: item.file });
			const response = await fetch(
				transcodeOutputUrl({ fileName: result.fileName }),
			);
			if (!response.ok) {
				throw new Error(`Could not download the proxy (${response.status}).`);
			}
			const blob = await response.blob();
			const proxyFile = new File([blob], `${item.name}.proxy.mp4`, {
				type: "video/mp4",
			});
			await editor.media.attachAssetProxy({
				projectId,
				assetId: item.id,
				proxyFile,
			});
			toast.success("Editing proxy ready — preview now uses it.", {
				id: toastId,
				description: "Exports still render from the original media.",
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Proxy generation failed.",
				{ id: toastId },
			);
		}
	};

	const handleCopyToCurrentScene = () => {
		if (!projectId || !activeSceneId) return;
		void editor.media.copyAssetToScene({
			projectId,
			assetId: item.id,
			targetSceneId: activeSceneId,
		});
	};

	const copyTitle = async () => {
		if (!item.socialCopy) return;
		try {
			await navigator.clipboard.writeText(item.socialCopy.title);
			toast.success(`${item.name} title copied.`);
		} catch {
			toast.error("Could not copy the title.");
		}
	};

	const copyDescription = async () => {
		if (!item.socialCopy) return;
		try {
			await navigator.clipboard.writeText(
				buildSocialDescriptionClipboardText({
					description: item.socialCopy.description,
					about,
					links,
				}),
			);
			toast.success(`${item.name} description copied.`);
		} catch {
			toast.error("Could not copy the description.");
		}
	};

	const movableFolders = folders.filter((f) => f.id !== item.folderId);
	const canMoveToRoot = !!item.folderId;

	return (
		<>
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent className={cn(item.socialCopy && "w-80")}>
				{item.socialCopy ? (
					<SocialCopyContextMenuSection
						socialCopy={item.socialCopy}
						onCopyTitle={() => { void copyTitle(); }}
						onCopyDescription={() => { void copyDescription(); }}
					/>
				) : null}
				<ContextMenuItem>Export clips</ContextMenuItem>
				<ContextMenuItem onClick={() => setAttributesOpen(true)}>
					Edit attributes
				</ContextMenuItem>
				{item.type === "video" && (
					<ContextMenuItem onClick={() => void handleGenerateProxy()}>
						{item.hasProxy
							? "Rebuild editing proxy"
							: "Use editing proxy (smooth playback)"}
					</ContextMenuItem>
				)}
				{item.type === "video" && (
					<ContextMenuSub>
						<ContextMenuSubTrigger>Transcode</ContextMenuSubTrigger>
						<ContextMenuSubContent>
							<ContextMenuItem
								onClick={() => void handleTranscode({ kind: "proxy" })}
							>
								H.264 proxy (540p) — download
							</ContextMenuItem>
							<ContextMenuItem
								onClick={() => void handleTranscode({ kind: "prores" })}
							>
								ProRes (standard)
							</ContextMenuItem>
						</ContextMenuSubContent>
					</ContextMenuSub>
				)}
				{item.sceneId != null && (
					<ContextMenuItem onClick={handleMakeProjectWide}>
						Make project-wide
					</ContextMenuItem>
				)}
				{activeSceneId && item.sceneId !== activeSceneId && (
					<ContextMenuItem onClick={handleCopyToCurrentScene}>
						Copy to current scene
					</ContextMenuItem>
				)}
				{(movableFolders.length > 0 || canMoveToRoot) && (
					<ContextMenuSub>
						<ContextMenuSubTrigger>Move to folder</ContextMenuSubTrigger>
						<ContextMenuSubContent>
							{canMoveToRoot && (
								<ContextMenuItem onClick={() => onMoveToFolder(item.id, null)}>
									Root (no folder)
								</ContextMenuItem>
							)}
							{movableFolders.map((folder) => (
								<ContextMenuItem
									key={folder.id}
									onClick={() => onMoveToFolder(item.id, folder.id)}
								>
									{folder.name}
								</ContextMenuItem>
							))}
						</ContextMenuSubContent>
					</ContextMenuSub>
				)}
				<ContextMenuItem
					variant="destructive"
					onClick={(event: React.MouseEvent<HTMLDivElement>) =>
						onRemove({ event, ids: idsToDelete })
					}
				>
					{deleteLabel}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
		<MediaAttributesDialog
			asset={item}
			projectId={projectId}
			open={attributesOpen}
			onOpenChange={setAttributesOpen}
		/>
		</>
	);
}

function MediaItemList({
	items,
	mode,
	folders,
	currentFolderId,
	onRemove,
	onMoveToFolder,
	activeSceneId,
	projectId,
}: {
	items: MediaAsset[];
	mode: MediaViewMode;
	folders: MediaFolder[];
	currentFolderId: string | null;
	onRemove: ({ event, ids }: { event: React.MouseEvent; ids: string[] }) => void;
	onMoveToFolder: (assetId: string, folderId: string | null) => void;
	activeSceneId: string | null;
	projectId: string;
}) {
	const isGrid = mode === "grid";

	return (
		<div
			className={cn(isGrid ? "grid gap-4" : "flex flex-col gap-1.5")}
			style={
				isGrid ? { gridTemplateColumns: "repeat(auto-fill, 7rem)" } : undefined
			}
		>
			{items.map((item) => (
				<MediaItemWithContextMenu
					item={item}
					folders={folders}
					currentFolderId={currentFolderId}
					onRemove={onRemove}
					onMoveToFolder={onMoveToFolder}
					activeSceneId={activeSceneId}
					projectId={projectId}
					key={item.id}
				>
					<SelectableItem className={cn(!isGrid && "w-full")} id={item.id}>
						<MediaAssetDraggable
							item={item}
							preview={
								<MediaPreview
									item={item}
									variant={isGrid ? "grid" : "compact"}
								/>
							}
							variant={isGrid ? "card" : "compact"}
							isRounded={isGrid ? false : undefined}
						/>
					</SelectableItem>
				</MediaItemWithContextMenu>
			))}
		</div>
	);
}

function formatDuration({ duration }: { duration: number }) {
	const min = Math.floor(duration / 60);
	const sec = Math.floor(duration % 60);
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MediaDurationBadge({ duration }: { duration?: number }) {
	if (!duration) return null;
	return (
		<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">
			{formatDuration({ duration })}
		</div>
	);
}

function MediaDurationLabel({ duration }: { duration?: number }) {
	if (!duration) return null;
	return (
		<span className="text-xs opacity-70">{formatDuration({ duration })}</span>
	);
}

function MediaTypePlaceholder({
	icon,
	label,
	duration,
	variant,
}: {
	icon: IconSvgElement;
	label: string;
	duration?: number;
	variant: "muted" | "bordered";
}) {
	const iconClassName = cn("size-6", variant === "bordered" && "mb-1");
	return (
		<div
			className={cn(
				"text-muted-foreground flex size-full flex-col items-center justify-center rounded",
				variant === "muted" ? "bg-muted/30" : "border",
			)}
		>
			<HugeiconsIcon icon={icon} className={iconClassName} />
			<span className="text-xs">{label}</span>
			<MediaDurationLabel duration={duration} />
		</div>
	);
}

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	const shouldShowDurationBadge = variant === "grid";

	if (item.type === "image") {
		return (
			<div className="relative flex size-full items-center justify-center bg-muted">
				<Image
					src={item.url ?? ""}
					alt={item.name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
				/>
				{isSubclipAsset({ asset: item }) ? (
					<SubclipBadge className="left-2" />
				) : null}
			</div>
		);
	}

	if (item.type === "video") {
		if (item.thumbnailUrl) {
			return (
				<div className="relative size-full">
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="100vw"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
					/>
					{isSubclipAsset({ asset: item }) ? (
						<SubclipBadge className="left-2" />
					) : null}
					{shouldShowDurationBadge ? (
						<MediaDurationBadge duration={item.duration} />
					) : null}
				</div>
			);
		}
		return (
			<MediaTypePlaceholder
				icon={Video01Icon}
				label="Video"
				duration={item.duration}
				variant="muted"
			/>
		);
	}

	if (item.type === "audio") {
		return (
			<div className="relative size-full">
				<MediaTypePlaceholder
					icon={MusicNote03Icon}
					label="Audio"
					duration={item.duration}
					variant="bordered"
				/>
				{isSubclipAsset({ asset: item }) ? (
					<SubclipBadge className="left-2" />
				) : null}
			</div>
		);
	}

	return (
		<MediaTypePlaceholder icon={Image02Icon} label="Unknown" variant="muted" />
	);
}

function SubclipBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"bg-background/90 text-foreground absolute top-2 rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-sm",
				className,
			)}
		>
			Subclip
		</span>
	);
}

function MediaActions({
	mediaViewMode,
	setMediaViewMode,
	isProcessing,
	sortBy,
	sortOrder,
	onSort,
	onImport,
	onNewFolder,
	showAllScenes,
	onToggleAllScenes,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
	onImport: () => void;
	onNewFolder?: () => void;
	showAllScenes?: boolean;
	onToggleAllScenes?: () => void;
}) {
	return (
		<div className="flex gap-1.5">
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={() =>
								setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
							}
							disabled={isProcessing}
							className="items-center justify-center"
						>
							{mediaViewMode === "grid" ? (
								<HugeiconsIcon icon={LeftToRightListDashIcon} />
							) : (
								<HugeiconsIcon icon={GridViewIcon} />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>
							{mediaViewMode === "grid"
								? "Switch to list view"
								: "Switch to grid view"}
						</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<DropdownMenu>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									disabled={isProcessing}
									className="items-center justify-center"
								>
									<HugeiconsIcon icon={SortingOneNineIcon} />
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<DropdownMenuContent align="end">
							<SortMenuItem
								label="Name"
								sortKey="name"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Type"
								sortKey="type"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Duration"
								sortKey="duration"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="File size"
								sortKey="size"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
					<TooltipContent>
						<p>
							Sort by {sortBy} (
							{sortOrder === "asc" ? "ascending" : "descending"})
						</p>
					</TooltipContent>
				</Tooltip>
				{onNewFolder ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="icon"
								variant="ghost"
								onClick={onNewFolder}
								disabled={isProcessing}
								className="items-center justify-center"
							>
								<HugeiconsIcon icon={FolderAddIcon} />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>New folder</p>
						</TooltipContent>
					</Tooltip>
				) : null}
			</TooltipProvider>
			{onToggleAllScenes && (
				<Button
					variant={showAllScenes ? "default" : "outline"}
					onClick={onToggleAllScenes}
					disabled={isProcessing}
					size="sm"
					className="items-center justify-center gap-1.5 text-xs"
					title={showAllScenes ? "Showing all scenes' media" : "Showing current scene's media"}
				>
					{showAllScenes ? "All scenes" : "This scene"}
				</Button>
			)}
			<Button
				variant="outline"
				onClick={onImport}
				disabled={isProcessing}
				size="sm"
				className="items-center justify-center gap-1.5"
			>
				<HugeiconsIcon icon={CloudUploadIcon} />
				Import
			</Button>
		</div>
	);
}

function SortMenuItem({
	label,
	sortKey,
	currentSortBy,
	currentSortOrder,
	onSort,
}: {
	label: string;
	sortKey: MediaSortKey;
	currentSortBy: MediaSortKey;
	currentSortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
}) {
	const isActive = currentSortBy === sortKey;
	const arrow = isActive ? (currentSortOrder === "asc" ? "↑" : "↓") : "";
	return (
		<DropdownMenuItem onClick={() => onSort({ key: sortKey })}>
			{label} {arrow}
		</DropdownMenuItem>
	);
}
