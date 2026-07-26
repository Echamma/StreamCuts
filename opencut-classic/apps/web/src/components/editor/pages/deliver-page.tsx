"use client";

import type { ReactNode } from "react";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { Timeline } from "@/timeline/components";
import { ExportQueueSection } from "@/components/editor/export-button";
import { getPagePanelSize, usePagePanelStore } from "@/editor/page-panel-store";
import { PagePanel } from "./page-panel";

const PAGE = "deliver" as const;

/**
 * The Deliver page: a preview of what will render, with the render queue as the
 * primary right-hand surface. Jobs are configured/added from the header Export
 * button; this page is where they queue, run, and report progress.
 */
export function DeliverPage({ preview }: { preview: ReactNode }) {
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
						setSize({ page: PAGE, panel: "preview", size: sizes[0] ?? 68 });
						setSize({ page: PAGE, panel: "queue", size: sizes[1] ?? 32 });
					}}
				>
					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "preview",
							fallback: 68,
						})}
						minSize={30}
						className="min-h-0 min-w-0 flex-1"
					>
						{preview}
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "queue",
							fallback: 32,
						})}
						minSize={20}
						maxSize={45}
						className="min-w-0"
					>
						<PagePanel>
							<div className="bg-background flex h-11 shrink-0 items-center border-b px-3.5">
								<span className="text-muted-foreground text-sm">
									Render queue
								</span>
							</div>
							<div className="flex-1 overflow-auto">
								<p className="text-muted-foreground p-3.5 text-xs text-balance">
									Configure an export with the Export button in the header, then
									choose Queue to add a render job here.
								</p>
								<ExportQueueSection />
							</div>
						</PagePanel>
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
