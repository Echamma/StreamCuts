"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useScrollPosition } from "@/timeline/hooks/use-scroll-position";

interface TimelineScrollState {
	scrollLeft: number;
	viewportWidth: number;
}

const TimelineScrollContext = createContext<TimelineScrollState>({
	scrollLeft: 0,
	viewportWidth: 0,
});

export function TimelineScrollProvider({
	scrollRef,
	children,
}: {
	scrollRef: React.RefObject<HTMLElement | null>;
	children: ReactNode;
}) {
	const { scrollLeft, viewportWidth } = useScrollPosition({ scrollRef });
	return (
		<TimelineScrollContext.Provider value={{ scrollLeft, viewportWidth }}>
			{children}
		</TimelineScrollContext.Provider>
	);
}

export function useTimelineScroll(): TimelineScrollState {
	return useContext(TimelineScrollContext);
}
