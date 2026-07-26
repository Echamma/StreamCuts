"use client";

import { useParams } from "next/navigation";
import { PreviewPanel } from "@/preview/components";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { Onboarding } from "@/components/editor/onboarding";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { EditPage } from "@/components/editor/pages/edit-page";
import { ColorPage } from "@/components/editor/pages/color-page";
import { MediaPage } from "@/components/editor/pages/media-page";
import { AudioPage } from "@/components/editor/pages/audio-page";
import { DeliverPage } from "@/components/editor/pages/deliver-page";
import { usePageStore } from "@/editor/page-store";
import { usePasteMedia } from "@/media/use-paste-media";
import { MobileGate } from "@/components/editor/mobile-gate";
import { useEffect, useMemo, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import { getGuidePreviewOverlaySource } from "@/guides";
import {
	bookmarkNotesPreviewOverlay,
	getBookmarkPreviewOverlaySource,
} from "@/timeline/bookmarks/index";
import {
	getSafeAreaPreviewOverlaySource,
	safeAreaPreviewOverlay,
} from "@/preview/safe-areas";
import { getScopesPreviewOverlaySource } from "@/preview/scopes";
import { loadAllUserFonts } from "@/fonts/user-fonts-store";
import { PageBar } from "@/components/editor/page-bar";
import { useFlag } from "@/flags";

export default function Editor() {
	const params = useParams();
	const projectId = params.project_id as string;

	return (
		<MobileGate>
			<EditorProvider projectId={projectId}>
				<div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
					<DegradedRendererBanner />
					<EditorHeader />
					<div className="min-h-0 min-w-0 flex-1">
						<EditorLayout />
					</div>
					<PageBarSlot />
					<Onboarding />
					<MigrationDialog />
					<ChangelogNotification />
				</div>
			</EditorProvider>
		</MobileGate>
	);
}

function PageBarSlot() {
	const pagesShellEnabled = useFlag("pages-shell");
	if (!pagesShellEnabled) return null;
	return <PageBar />;
}

function DegradedRendererBanner() {
	const isDegraded = useEditor((e) => e.renderer.isDegraded);
	const [dismissed, setDismissed] = useState(false);
	if (!isDegraded || dismissed) return null;

	return (
		<div className="bg-accent border-b h-9 flex items-center justify-center gap-2 text-xs text-muted-foreground">
			<span>For the best experience, open OpenCut in Chrome.</span>
			<Button
				variant="text"
				size="icon"
				className="p-0 w-auto [&_svg]:size-3.5"
				onClick={() => setDismissed(true)}
				aria-label="Dismiss"
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</div>
	);
}

function EditorLayout() {
	usePasteMedia();
	useEffect(() => { void loadAllUserFonts(); }, []);
	const activeScene = useEditor((editor) =>
		editor.scenes.getActiveSceneOrNull(),
	);
	const currentTime = useEditor((editor) => editor.playback.getCurrentTime());
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});
	const showSafeAreas = isPreviewOverlayVisible({
		overlay: safeAreaPreviewOverlay,
		overlays,
	});

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					getSafeAreaPreviewOverlaySource({ isVisible: showSafeAreas }),
					getScopesPreviewOverlaySource(),
					activeScene
						? getBookmarkPreviewOverlaySource({
								bookmarks: activeScene.bookmarks,
								time: currentTime,
								isVisible: showBookmarkNotes,
							})
						: {
								definitions: [bookmarkNotesPreviewOverlay],
								instances: [],
							},
				],
			}),
		[activeGuide, activeScene, currentTime, showBookmarkNotes, showSafeAreas],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	// The preview (and its overlay wiring) is built once here and injected into
	// whichever page is active, so overlay logic lives in a single place.
	const preview = (
		<PreviewPanel
			overlayControls={overlayControls}
			overlayInstances={overlaySource.instances}
			onOverlayVisibilityChange={setOverlayVisibility}
		/>
	);

	// With the pages-shell flag off, we always render Edit (today's layout,
	// verbatim) — a never-switch user sees zero change.
	const pagesShellEnabled = useFlag("pages-shell");
	const activePage = usePageStore((state) => state.activePage);
	const page = pagesShellEnabled ? activePage : "edit";

	switch (page) {
		case "media":
			return <MediaPage preview={preview} />;
		case "color":
			return <ColorPage preview={preview} />;
		case "audio":
			return <AudioPage preview={preview} />;
		case "deliver":
			return <DeliverPage preview={preview} />;
		default:
			return <EditPage preview={preview} />;
	}
}
