import type { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import type { ProjectSnapshotRecord } from "@/services/storage/types";

const DEFAULT_DEBOUNCE_MS = 5_000;

function generateSnapshotId({ prefix }: { prefix: string }): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${prefix}-${ts}-${rand}`;
}

/** Debounced autosave loop that snapshots the active project into the
 * `project_snapshots` IndexedDB store after each command lands. Distinct
 * from SaveManager, which writes the main project record — snapshots are
 * additive, retained, and the basis for crash recovery + named versions. */
export class SnapshotManager {
	private debounceMs: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending = false;
	private isWriting = false;
	private unsubscribe: (() => void) | null = null;
	private editor: EditorCore;
	private listeners = new Set<() => void>();
	private lastSnapshot: ProjectSnapshotRecord | null = null;

	constructor({
		editor,
		debounceMs = DEFAULT_DEBOUNCE_MS,
	}: {
		editor: EditorCore;
		debounceMs?: number;
	}) {
		this.editor = editor;
		this.debounceMs = debounceMs;
	}

	start(): void {
		if (this.unsubscribe) return;
		// Piggyback on the same dirty signal SaveManager uses — every successful
		// command run triggers a scenes/timeline notification, which is what we
		// debounce on. Reactors on the command manager would also work but this
		// is simpler and one source of truth.
		const unsubs = [
			this.editor.scenes.subscribe(() => this.markDirty()),
			this.editor.timeline.subscribe(() => this.markDirty()),
		];
		this.unsubscribe = () => {
			for (const fn of unsubs) fn();
		};
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.clearTimer();
	}

	markDirty(): void {
		this.pending = true;
		this.queueWrite();
	}

	/** Capture a named, retained version with an optional user note. Bypasses
	 * the debounce and writes immediately so the UI can show "Version saved"
	 * synchronously. */
	async saveNamedVersion({
		label,
	}: {
		label: string;
	}): Promise<ProjectSnapshotRecord | null> {
		return this.writeSnapshot({ source: "manual", label });
	}

	async listSnapshots(): Promise<ProjectSnapshotRecord[]> {
		const project = this.editor.project.getActiveOrNull();
		if (!project) return [];
		return storageService.listProjectSnapshots({
			projectId: project.metadata.id,
		});
	}

	getLastSnapshot(): ProjectSnapshotRecord | null {
		return this.lastSnapshot;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private queueWrite(): void {
		if (this.isWriting) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.writeSnapshot({ source: "autosave" });
		}, this.debounceMs);
	}

	private async writeSnapshot({
		source,
		label,
	}: {
		source: "autosave" | "manual";
		label?: string;
	}): Promise<ProjectSnapshotRecord | null> {
		if (this.isWriting) return null;
		const project = this.editor.project.getActiveOrNull();
		if (!project) return null;
		if (this.editor.project.getIsLoading()) return null;
		if (this.editor.project.getMigrationState().isMigrating) return null;

		this.isWriting = true;
		this.pending = false;
		this.clearTimer();
		try {
			const snapshot = await storageService.saveProjectSnapshot({
				project,
				snapshotId: generateSnapshotId({ prefix: source }),
				source,
				label,
			});
			this.lastSnapshot = snapshot;
			this.notify();
			return snapshot;
		} catch (error) {
			console.warn("[snapshots] failed to write snapshot", error);
			return null;
		} finally {
			this.isWriting = false;
			if (this.pending) this.queueWrite();
		}
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = null;
	}
}

export interface RecoveryCandidate {
	snapshot: ProjectSnapshotRecord;
	staleByMs: number;
}

/** A snapshot newer than the project's main `updatedAt` indicates that work
 * was made after the last successful save — typically because the tab
 * crashed before SaveManager could flush. Surfaces a Recover/Discard
 * banner in the UI when it returns non-null. */
export async function findRecoveryCandidate({
	projectId,
	projectUpdatedAt,
}: {
	projectId: string;
	projectUpdatedAt: Date;
}): Promise<RecoveryCandidate | null> {
	const latest = await storageService.getLatestProjectSnapshot({ projectId });
	if (!latest) return null;
	const snapshotTime = new Date(latest.savedAt).getTime();
	const projectTime = projectUpdatedAt.getTime();
	if (snapshotTime <= projectTime) return null;
	return {
		snapshot: latest,
		staleByMs: snapshotTime - projectTime,
	};
}
