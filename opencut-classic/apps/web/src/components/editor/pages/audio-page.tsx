"use client";

import type { ReactNode } from "react";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { Timeline } from "@/timeline/components";
import { AudioMixerView } from "@/components/editor/panels/assets/views/audio-mixer";
import { getPagePanelSize, usePagePanelStore } from "@/editor/page-panel-store";
import { PagePanel } from "./page-panel";

const PAGE = "audio" as const;

/**
 * The Audio page: the mixer (levels/pan/mute/solo/meters) as the primary
 * surface, preview alongside, timeline below. Relocation of the audio-mixer
 * view into a mixing-focused workspace over the same shared editor state.
 */
export function AudioPage({ preview }: { preview: ReactNode }) {
	const setSize = usePagePanelStore((state) => state.setSize);

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={(sizes) => {
				setSize({ page: PAGE, panel: "mainContent", size: sizes[0] ?? 60 });
				setSize({ page: PAGE, panel: "timeline", size: sizes[1] ?? 40 });
			}}
		>
			<ResizablePanel
				defaultSize={getPagePanelSize({
					page: PAGE,
					panel: "mainContent",
					fallback: 60,
				})}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						setSize({ page: PAGE, panel: "mixer", size: sizes[0] ?? 44 });
						setSize({ page: PAGE, panel: "preview", size: sizes[1] ?? 56 });
					}}
				>
					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "mixer",
							fallback: 44,
						})}
						minSize={25}
						maxSize={65}
						className="min-w-0"
					>
						<PagePanel>
							<AudioMixerView />
						</PagePanel>
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={getPagePanelSize({
							page: PAGE,
							panel: "preview",
							fallback: 56,
						})}
						minSize={30}
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
					fallback: 40,
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
