"use client";

import { useEffect, useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useEditor } from "@/editor/use-editor";
import {
	LONG_TO_SHORT_API_BASE,
	checkLongToShortHealth,
	processLongToShort,
	revealLongToShortFolder,
	resolveLongToShortUrl,
	type LongToShortClip,
	type LongToShortResult,
} from "@/long-to-short/api";
import { processMediaAssets } from "@/media/processing";
import { buildSocialDescriptionClipboardText } from "@/socials/copy";
import { SocialCopyContextMenuSection } from "@/socials/components/context-menu-copy";
import { useSocialsStore } from "@/socials/store";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { cn } from "@/utils/ui";
import {
	CheckmarkCircle01Icon,
	CloudDownloadIcon,
	CloudUploadIcon,
	Copy01Icon,
	Folder03Icon,
	PlayIcon,
	ReloadIcon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type BackendState = "checking" | "online" | "offline";

export function LongToShortView() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const socialAbout = useSocialsStore((state) => state.about);
	const socialLinks = useSocialsStore((state) => state.links);
	const videoAssets = useMemo(
		() =>
			mediaAssets.filter((asset) => asset.type === "video" && !asset.ephemeral),
		[mediaAssets],
	);
	const [backendState, setBackendState] = useState<BackendState>("checking");
	const [backendMessage, setBackendMessage] = useState(
		"Checking backend status...",
	);
	const [selectedAssetId, setSelectedAssetId] = useState("");
	const [uploadedFile, setUploadedFile] = useState<File | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isImportingAll, setIsImportingAll] = useState(false);
	const [isOpeningFolder, setIsOpeningFolder] = useState(false);
	const [importingClipIds, setImportingClipIds] = useState<string[]>([]);
	const [importedClipIds, setImportedClipIds] = useState<string[]>([]);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [result, setResult] = useState<LongToShortResult | null>(null);
	const [previewClipId, setPreviewClipId] = useState<string | null>(null);
	const [useTranscript, setUseTranscript] = useState(true);

	const savedTranscript = activeProject?.transcript ?? null;

	const effectiveSelectedAssetId =
		selectedAssetId && videoAssets.some((asset) => asset.id === selectedAssetId)
			? selectedAssetId
			: (videoAssets[0]?.id ?? "");
	const selectedAsset =
		videoAssets.find((asset) => asset.id === effectiveSelectedAssetId) ?? null;
	const sourceFile = uploadedFile ?? selectedAsset?.file ?? null;
	const uploadedPreviewUrl = useMemo(
		() => (uploadedFile ? URL.createObjectURL(uploadedFile) : null),
		[uploadedFile],
	);
	const previewUrl = uploadedPreviewUrl ?? selectedAsset?.url ?? null;
	const previewClip =
		result?.clips.find((clip) => clip.id === previewClipId) ?? null;

	const copyTitle = async ({ clip }: { clip: LongToShortClip }) => {
		try {
			await navigator.clipboard.writeText(clip.socialCopy.title);
			toast.success(`${clip.label} title copied.`);
		} catch {
			toast.error("Could not copy the title.");
		}
	};

	const copyDescription = async ({ clip }: { clip: LongToShortClip }) => {
		try {
			await navigator.clipboard.writeText(
				buildSocialDescriptionClipboardText({
					description: clip.socialCopy.description,
					about: socialAbout,
					links: socialLinks,
				}),
			);
			toast.success(`${clip.label} description copied.`);
		} catch {
			toast.error("Could not copy the description.");
		}
	};

	useEffect(() => {
		let isMounted = true;

		checkLongToShortHealth()
			.then(() => {
				if (!isMounted) return;

				setBackendState("online");
				setBackendMessage(`Backend ready at ${LONG_TO_SHORT_API_BASE}`);
			})
			.catch(() => {
				if (!isMounted) return;

				setBackendState("offline");
				setBackendMessage(
					"Backend offline. Start backend/long-to-short before processing a video.",
				);
			});

		return () => {
			isMounted = false;
		};
	}, []);

	useEffect(() => {
		return () => {
			if (uploadedPreviewUrl) {
				URL.revokeObjectURL(uploadedPreviewUrl);
			}
		};
	}, [uploadedPreviewUrl]);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();

		if (!sourceFile) {
			setErrorMessage("Choose an imported video asset or upload a video file.");
			return;
		}

		setIsSubmitting(true);
		setErrorMessage(null);
		setImportedClipIds([]);

		try {
			const nextResult = await processLongToShort({
				video: sourceFile,
				transcript: savedTranscript && useTranscript ? savedTranscript.text : undefined,
			});

			setResult(nextResult);
			toast.success(`Generated ${nextResult.clipCount} clips.`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to generate clips.";
			setErrorMessage(message);
			toast.error("Long to Short failed", { description: message });
		} finally {
			setIsSubmitting(false);
		}
	};

	const importClip = async ({ clip }: { clip: LongToShortClip }) => {
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		setImportingClipIds((current) => [...current, clip.id]);

		try {
			const file = await downloadClipAsFile({ clip });
			const processedAssets = await processMediaAssets({ files: [file] });
			const processedAsset = processedAssets[0];

			if (!processedAsset) {
				throw new Error("The generated clip could not be processed.");
			}

			const importedAsset = await editor.media.addMediaAsset({
				projectId: activeProject.metadata.id,
				asset: {
					...processedAsset,
					socialCopy: clip.socialCopy,
				},
			});

			if (!importedAsset) {
				throw new Error("The generated clip could not be imported.");
			}

			setImportedClipIds((current) => [...current, clip.id]);
			toast.success(`${clip.label} imported to media.`);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Could not import generated clip.";
			toast.error(`Import failed for ${clip.label}`, { description: message });
		} finally {
			setImportingClipIds((current) => current.filter((id) => id !== clip.id));
		}
	};

	const importAllClips = async () => {
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		if (!result || result.clips.length === 0) {
			return;
		}

		setIsImportingAll(true);

		try {
			const files = await Promise.all(
				result.clips.map((clip) => downloadClipAsFile({ clip })),
			);
			const processedAssets = await processMediaAssets({ files });
			let importedCount = 0;
			const nextImportedClipIds: string[] = [];

			for (const [index, processedAsset] of processedAssets.entries()) {
				const clip = result.clips[index];
				if (!clip || !processedAsset) {
					continue;
				}

				const importedAsset = await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset: {
						...processedAsset,
						socialCopy: clip.socialCopy,
					},
				});

				if (importedAsset) {
					importedCount += 1;
					nextImportedClipIds.push(clip.id);
				}
			}

			setImportedClipIds(nextImportedClipIds);
			toast.success(`Imported ${importedCount} clips to media.`);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Could not import generated clips.";
			toast.error("Import all failed", { description: message });
		} finally {
			setIsImportingAll(false);
		}
	};

	const openExtractFolder = async () => {
		if (!result) {
			return;
		}

		setIsOpeningFolder(true);

		try {
			const revealResult = await revealLongToShortFolder({
				jobId: result.jobId,
			});
			toast.success("Opened extract folder.", {
				description: revealResult.folderPath,
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Could not open extract folder.";
			toast.error("Open folder failed", { description: message });
		} finally {
			setIsOpeningFolder(false);
		}
	};

	return (
		<PanelView
			title="Long to Short"
			actions={
				<div
					className={cn(
						"text-xs flex items-center gap-1.5",
						backendState === "online"
							? "text-emerald-600"
							: backendState === "offline"
								? "text-destructive"
								: "text-muted-foreground",
					)}
				>
					<span
						className={cn(
							"size-2 rounded-full",
							backendState === "online"
								? "bg-emerald-500"
								: backendState === "offline"
									? "bg-destructive"
									: "bg-muted-foreground",
						)}
					/>
					{backendState === "online"
						? "Online"
						: backendState === "offline"
							? "Offline"
							: "Checking"}
				</div>
			}
		>
			<div className="flex flex-col gap-4 pb-4">
				<div className="rounded-md border bg-accent/35 p-3">
					<p className="text-sm font-medium">
						Generate short clips with the backend service.
					</p>
					<p className="text-muted-foreground mt-1 text-xs leading-5">
						{backendMessage}
					</p>
				</div>

				<form className="flex flex-col gap-4" onSubmit={handleSubmit}>
					<div className="flex flex-col gap-2">
						<p className="text-sm font-medium">Source from project media</p>
						<Select
							value={effectiveSelectedAssetId}
							onValueChange={(value) => {
								setSelectedAssetId(value);
								setResult(null);
								setPreviewClipId(null);
								setErrorMessage(null);
							}}
							disabled={videoAssets.length === 0 || uploadedFile !== null}
						>
							<SelectTrigger
								className="w-full justify-between"
								variant="outline"
							>
								<SelectValue
									placeholder={
										videoAssets.length === 0
											? "Import a video into media first"
											: "Select a video asset"
									}
								/>
							</SelectTrigger>
							<SelectContent>
								{videoAssets.map((asset) => (
									<SelectItem key={asset.id} value={asset.id}>
										{asset.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-2">
							<p className="text-sm font-medium">
								Or upload a one-off source file
							</p>
							{uploadedFile ? (
								<Button
									variant="text"
									size="sm"
									onClick={() => {
										setUploadedFile(null);
										setResult(null);
										setPreviewClipId(null);
										setErrorMessage(null);
									}}
								>
									Clear
								</Button>
							) : null}
						</div>
						<Input
							id="long-to-short-upload"
							type="file"
							accept="video/*"
							onChange={(event) => {
								const nextFile = event.currentTarget.files?.[0] ?? null;
								setUploadedFile(nextFile);
								setResult(null);
								setPreviewClipId(null);
								setErrorMessage(null);
							}}
						/>
					</div>

					<div className="rounded-md border bg-background p-3 text-sm">
						<p className="font-medium">Gemini clip planning</p>
						<p className="text-muted-foreground mt-1 leading-5">
							Gemini will choose how many clips to create, how long they should
							be, and which moments are strongest. If Gemini is unavailable, the
							backend falls back to an automatic planner.
						</p>
					</div>

					{sourceFile ? (
						<div className="rounded-md border bg-background p-3">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<p className="text-sm font-medium truncate">
										{sourceFile.name}
									</p>
									<p className="text-muted-foreground mt-1 text-xs">
										{formatMegabytes({ bytes: sourceFile.size })}
									</p>
								</div>
								<div className="text-muted-foreground flex items-center gap-1 text-xs">
									<HugeiconsIcon icon={Video01Icon} className="size-3.5" />
									{uploadedFile ? "Uploaded file" : "Project media"}
								</div>
							</div>
							{previewUrl ? (
								<p className="text-muted-foreground mt-3 text-xs">
									Preview available in the media panel and timeline viewer.
								</p>
							) : null}
						</div>
					) : null}

					{savedTranscript ? (
						<label className="flex items-center gap-2 cursor-pointer select-none">
							<input
								type="checkbox"
								checked={useTranscript}
								onChange={(e) => setUseTranscript(e.target.checked)}
								className="rounded border-border"
							/>
							<span className="text-sm">
								Send saved transcript to backend
							</span>
						</label>
					) : null}

					{errorMessage ? (
						<p className="text-destructive text-sm font-medium">
							{errorMessage}
						</p>
					) : null}

					<Button
						type="submit"
						disabled={isSubmitting || !sourceFile}
						className="w-full"
					>
						{isSubmitting ? (
							<>
								<HugeiconsIcon
									icon={ReloadIcon}
									className="size-4 animate-spin"
								/>
								Processing...
							</>
						) : (
							<>
								<HugeiconsIcon icon={PlayIcon} className="size-4" />
								Generate clips
							</>
						)}
					</Button>
				</form>

				{result ? (
					<>
						<Separator />

						<div className="flex flex-col gap-3">
							<div className="flex items-start justify-between gap-3">
								<div>
									<p className="text-sm font-medium">
										{result.clipCount} clips ready
									</p>
									<p className="text-muted-foreground mt-1 text-xs leading-5">
										Source{" "}
										{formatSeconds({ seconds: result.sourceDurationSeconds })} |
										Clips chosen automatically
									</p>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={importAllClips}
									disabled={isImportingAll}
								>
									<HugeiconsIcon icon={CloudUploadIcon} className="size-4" />
									{isImportingAll ? "Importing..." : "Import all"}
								</Button>
							</div>

							<div className="text-muted-foreground grid gap-1 text-xs">
								<span>File: {result.originalFileName}</span>
								<span>Job: {result.jobId}</span>
							</div>

							<div className="flex flex-col gap-2">
								{result.clips.map((clip) => {
									const isImported = importedClipIds.includes(clip.id);
									const isImporting = importingClipIds.includes(clip.id);

									return (
										<ContextMenu key={clip.id}>
											<ContextMenuTrigger asChild>
												<div className="bg-accent/30 flex flex-col gap-3 rounded-md border p-3">
													<div className="flex items-start justify-between gap-2">
														<div>
															<p className="text-sm font-medium">
																{clip.label}
															</p>
															<p className="text-muted-foreground mt-1 text-xs">
																{formatTimestamp({
																	totalSeconds: clip.startSeconds,
																})}{" "}
																to{" "}
																{formatTimestamp({
																	totalSeconds: clip.endSeconds,
																})}
															</p>
														</div>
														<span className="text-muted-foreground text-xs">
															{formatSeconds({ seconds: clip.durationSeconds })}
														</span>
													</div>

													<div className="text-muted-foreground grid gap-1 text-xs">
														<span>Rendered {clip.renderedSizeMb} MB</span>
														<span>
															Source estimate{" "}
															{clip.estimatedSourceSizeMb != null
																? `${clip.estimatedSourceSizeMb} MB`
																: "n/a"}
														</span>
													</div>

													<div className="rounded-md border bg-background/70 p-3">
														<div className="flex items-start justify-between gap-3">
															<div className="min-w-0">
																<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
																	TikTok copy
																</p>
																<p className="mt-1 text-sm font-medium leading-5">
																	{clip.socialCopy.title}
																</p>
															</div>
															<Button
																variant="ghost"
																size="sm"
																onClick={() => {
																	void copyDescription({ clip });
																}}
															>
																<HugeiconsIcon
																	icon={Copy01Icon}
																	className="size-4"
																/>
																Copy description
															</Button>
														</div>
														<p className="text-muted-foreground mt-2 whitespace-pre-wrap text-xs leading-5">
															{clip.socialCopy.description}
														</p>
														<p className="text-muted-foreground mt-2 text-[11px] uppercase tracking-wide">
															{clip.socialCopy.provider === "gemini"
																? "Gemini suggestion"
																: "Fallback suggestion"}
														</p>
													</div>

													<div className="flex flex-wrap gap-2">
														<Button
															variant="outline"
															size="sm"
															onClick={() => setPreviewClipId(clip.id)}
														>
															<HugeiconsIcon
																icon={PlayIcon}
																className="size-4"
															/>
															Preview
														</Button>
														<Button variant="outline" size="sm" asChild>
															<a
																href={resolveLongToShortUrl({
																	path: clip.downloadUrl,
																})}
																target="_blank"
																rel="noreferrer"
															>
																<HugeiconsIcon
																	icon={CloudDownloadIcon}
																	className="size-4"
																/>
																Download
															</a>
														</Button>
														<Button
															variant="outline"
															size="sm"
															onClick={openExtractFolder}
															disabled={isOpeningFolder}
														>
															<HugeiconsIcon
																icon={Folder03Icon}
																className="size-4"
															/>
															{isOpeningFolder ? "Opening..." : "Open folder"}
														</Button>
														<Button
															variant={isImported ? "secondary" : "outline"}
															size="sm"
															onClick={() => importClip({ clip })}
															disabled={isImporting || isImported}
														>
															{isImported ? (
																<>
																	<HugeiconsIcon
																		icon={CheckmarkCircle01Icon}
																		className="size-4"
																	/>
																	Imported
																</>
															) : (
																<>
																	<HugeiconsIcon
																		icon={CloudUploadIcon}
																		className="size-4"
																	/>
																	{isImporting
																		? "Importing..."
																		: "Import to media"}
																</>
															)}
														</Button>
													</div>
												</div>
											</ContextMenuTrigger>
											<ContextMenuContent className="w-80">
												<SocialCopyContextMenuSection
													socialCopy={clip.socialCopy}
													onCopyTitle={() => {
														void copyTitle({ clip });
													}}
													onCopyDescription={() => {
														void copyDescription({ clip });
													}}
												/>
											</ContextMenuContent>
										</ContextMenu>
									);
								})}
							</div>
						</div>
					</>
				) : null}
			</div>
			<Dialog
				open={previewClip !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPreviewClipId(null);
					}
				}}
			>
				<DialogContent className="max-w-3xl">
					<DialogTitle>
						{previewClip ? `${previewClip.label} preview` : "Clip preview"}
					</DialogTitle>
					{previewClip ? (
						<DialogBody className="gap-4">
							<div className="overflow-hidden rounded-md border bg-black">
								{/* eslint-disable-next-line jsx-a11y/media-has-caption -- generated clips do not include caption tracks */}
								<video
									key={previewClip.id}
									src={resolveLongToShortUrl({ path: previewClip.downloadUrl })}
									controls
									preload="metadata"
									playsInline
									className="aspect-video w-full"
								/>
							</div>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<p className="text-sm font-medium">{previewClip.label}</p>
									<p className="text-muted-foreground mt-1 text-xs leading-5">
										{formatTimestamp({
											totalSeconds: previewClip.startSeconds,
										})}{" "}
										to{" "}
										{formatTimestamp({ totalSeconds: previewClip.endSeconds })}{" "}
										| {formatSeconds({ seconds: previewClip.durationSeconds })}
									</p>
								</div>
								<div className="text-muted-foreground text-right text-xs">
									<p>Rendered {previewClip.renderedSizeMb} MB</p>
									<p>
										Source estimate{" "}
										{previewClip.estimatedSourceSizeMb != null
											? `${previewClip.estimatedSourceSizeMb} MB`
											: "n/a"}
									</p>
								</div>
							</div>
							<div className="rounded-md border bg-background/70 p-3">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
											TikTok copy
										</p>
										<p className="mt-1 text-sm font-medium leading-5">
											{previewClip.socialCopy.title}
										</p>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												void copyTitle({ clip: previewClip });
											}}
										>
											<HugeiconsIcon icon={Copy01Icon} className="size-4" />
											Copy title
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												void copyDescription({ clip: previewClip });
											}}
										>
											<HugeiconsIcon icon={Copy01Icon} className="size-4" />
											Copy description
										</Button>
									</div>
								</div>
								<p className="text-muted-foreground mt-2 whitespace-pre-wrap text-xs leading-5">
									{previewClip.socialCopy.description}
								</p>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button variant="outline" size="sm" asChild>
									<a
										href={resolveLongToShortUrl({
											path: previewClip.downloadUrl,
										})}
										target="_blank"
										rel="noreferrer"
									>
										<HugeiconsIcon
											icon={CloudDownloadIcon}
											className="size-4"
										/>
										Download
									</a>
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => importClip({ clip: previewClip })}
									disabled={
										importingClipIds.includes(previewClip.id) ||
										importedClipIds.includes(previewClip.id)
									}
								>
									{importedClipIds.includes(previewClip.id) ? (
										<>
											<HugeiconsIcon
												icon={CheckmarkCircle01Icon}
												className="size-4"
											/>
											Imported
										</>
									) : (
										<>
											<HugeiconsIcon
												icon={CloudUploadIcon}
												className="size-4"
											/>
											{importingClipIds.includes(previewClip.id)
												? "Importing..."
												: "Import to media"}
										</>
									)}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={openExtractFolder}
									disabled={isOpeningFolder}
								>
									<HugeiconsIcon icon={Folder03Icon} className="size-4" />
									{isOpeningFolder ? "Opening..." : "Open folder"}
								</Button>
							</div>
						</DialogBody>
					) : null}
				</DialogContent>
			</Dialog>
		</PanelView>
	);
}

async function downloadClipAsFile({ clip }: { clip: LongToShortClip }) {
	const response = await fetch(
		resolveLongToShortUrl({ path: clip.downloadUrl }),
	);

	if (!response.ok) {
		throw new Error(`Failed to download ${clip.label}.`);
	}

	const blob = await response.blob();
	return new File(
		[blob],
		`${clip.label.toLowerCase().replace(/\s+/g, "-")}.mp4`,
		{
			type: blob.type || "video/mp4",
		},
	);
}

function formatMegabytes({ bytes }: { bytes: number }) {
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatSeconds({ seconds }: { seconds: number }) {
	return `${Math.round(seconds)} sec`;
}

function formatTimestamp({ totalSeconds }: { totalSeconds: number }) {
	const seconds = Math.floor(totalSeconds % 60);
	const minutes = Math.floor((totalSeconds / 60) % 60);
	const hours = Math.floor(totalSeconds / 3600);

	return [hours, minutes, seconds]
		.map((value) => String(value).padStart(2, "0"))
		.join(":");
}
