"use client";

import type { ReactNode } from "react";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Timeline } from "@/timeline/components";
import { ScopesDock } from "@/scopes/components/scopes-dock";
import { getPagePanelSize, usePagePanelStore } from "@/editor/page-panel-store";

const PAGE = "color" as const;

/**
 * The Color page: a grading-focused arrangement over the shared editor state —
 * scopes docked left, preview centre, grade controls (the properties panel,
 * which surfaces the color-wheels control for a selected clip) right, timeline
 * below. Same document, different workspace: a switch here is a pure view
 * change.
 */
export function ColorPage({ preview }: { preview: ReactNode }) {
	const setSize = usePagePanelStore((state) => state.setSize);

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={(sizes) => {
				setSize({ page: PAGE, panel: "mainContent", size: sizes[0] ?? 65 });
				setSize({ page: PAGE, panel: "timeline", size: sizes[1] ?? 35 });
			}}
		>
			<ResizablePanel
				defaultSize={getPagePanelSize({
					page: PAGE,
					panel: "mainContent",
					fallback: 65,
				})}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						setSize({ page: PAGE, panel: "scopes", size: sizes[0] ?? 26 });
						setSize({ page: PAGE, panel: "preview", size: sizes[1] ?? 48 });
						setSize({ page: PAGE, panel: "grade", size: sizes[2] ?? 26 });
					}}
				>
					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "scopes",
							fallback: 26,
						})}
						minSize={16}
						maxSize={40}
						className="min-w-0"
					>
						<div className="border-border/60 h-full overflow-hidden rounded-sm border">
							<ScopesDock />
						</div>
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "preview",
							fallback: 48,
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
							panel: "grade",
							fallback: 26,
						})}
						minSize={16}
						maxSize={40}
						className="min-w-0"
					>
						<PropertiesPanel />
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle withHandle />

			<ResizablePanel
				defaultSize={getPagePanelSize({
					page: PAGE,
					panel: "timeline",
					fallback: 35,
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
