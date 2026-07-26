"use client";

import type { ReactNode } from "react";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { Timeline } from "@/timeline/components";
import { MediaView } from "@/components/editor/panels/assets/views/assets";
import { getPagePanelSize, usePagePanelStore } from "@/editor/page-panel-store";
import { PagePanel } from "./page-panel";

const PAGE = "media" as const;

/**
 * The Media page: the media pool as the primary surface, preview alongside for
 * inspecting a selected clip, timeline below. Relocation of existing panels —
 * same shared editor state, a different workspace.
 */
export function MediaPage({ preview }: { preview: ReactNode }) {
	const setSize = usePagePanelStore((state) => state.setSize);

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={(sizes) => {
				setSize({ page: PAGE, panel: "mainContent", size: sizes[0] ?? 62 });
				setSize({ page: PAGE, panel: "timeline", size: sizes[1] ?? 38 });
			}}
		>
			<ResizablePanel
				defaultSize={getPagePanelSize({
					page: PAGE,
					panel: "mainContent",
					fallback: 62,
				})}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						setSize({ page: PAGE, panel: "pool", size: sizes[0] ?? 62 });
						setSize({ page: PAGE, panel: "preview", size: sizes[1] ?? 38 });
					}}
				>
					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "pool",
							fallback: 62,
						})}
						minSize={30}
						className="min-w-0"
					>
						<PagePanel>
							<MediaView />
						</PagePanel>
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "preview",
							fallback: 38,
						})}
						minSize={25}
						className="min-h-0 min-w-0"
					>
						{preview}
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle withHandle />

			<ResizablePanel
				defaultSize={getPagePanelSize({
					page: PAGE,
					panel: "timeline",
					fallback: 38,
				})}
				minSize={15}
				maxSize={70}
				className="min-h-0 px-3 pb-3"
			>
				<Timeline />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
