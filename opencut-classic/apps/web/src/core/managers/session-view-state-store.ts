import type { TTimelineViewState } from "@/project/types";
import { storageService } from "@/services/storage/service";

export class SessionViewStateStore {
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingProjectId: string | null = null;
	private pendingViewState: TTimelineViewState | null = null;

	constructor(private debounceMs = 250) {}

	async load({
		projectId,
		fallback,
	}: {
		projectId: string;
		fallback?: TTimelineViewState;
	}): Promise<TTimelineViewState | undefined> {
		const persisted = await storageService.loadSessionViewState({ projectId });
		return persisted ?? fallback;
	}

	set({
		projectId,
		viewState,
	}: {
		projectId: string;
		viewState: TTimelineViewState;
	}): void {
		this.pendingProjectId = projectId;
		this.pendingViewState = viewState;
		this.scheduleSave();
	}

	async flush(): Promise<void> {
		if (!this.pendingProjectId || !this.pendingViewState) {
			return;
		}

		const projectId = this.pendingProjectId;
		const viewState = this.pendingViewState;
		this.pendingProjectId = null;
		this.pendingViewState = null;
		this.clearTimer();
		await storageService.saveSessionViewState({ projectId, viewState });
	}

	async clear({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		if (this.pendingProjectId === projectId) {
			this.pendingProjectId = null;
			this.pendingViewState = null;
		}
		await storageService.deleteSessionViewState({ projectId });
	}

	destroy(): void {
		this.clearTimer();
	}

	private scheduleSave(): void {
		this.clearTimer();
		this.saveTimer = setTimeout(() => {
			void this.flush();
		}, this.debounceMs);
	}

	private clearTimer(): void {
		if (!this.saveTimer) {
			return;
		}

		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
