import type {
	TProject,
	TProjectMetadata,
	TTimelineViewState,
} from "@/project/types";
import type { SocialCopy } from "@/socials/types";
import type { RetimeConfig, TScene } from "@/timeline";

export type MediaType = "image" | "video" | "audio";

export interface FileMediaAssetSource {
	kind: "file";
}

export interface SubclipMediaAssetSource {
	kind: "subclip";
	rootSourceAssetId: string;
	sourceStartTime: number;
	sourceDuration: number;
	timelineDuration: number;
	retime?: RetimeConfig;
	includeAudio?: boolean;
	savedFromAssetId: string;
}

export type MediaAssetSource = FileMediaAssetSource | SubclipMediaAssetSource;

export interface StorageAdapter<T> {
	get(key: string): Promise<T | null>;
	set(args: { key: string; value: T }): Promise<void>;
	remove(key: string): Promise<void>;
	list(): Promise<string[]>;
	clear(): Promise<void>;
}

export interface MediaAssetData {
	id: string;
	name: string;
	type: MediaType;
	size: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	ephemeral?: boolean;
	thumbnailUrl?: string;
	socialCopy?: SocialCopy;
	folderId?: string | null;
	sceneId?: string;
	source?: MediaAssetSource;
}

export type SerializedScene = Omit<TScene, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProjectMetadata = Omit<
	TProjectMetadata,
	"createdAt" | "updatedAt"
> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProject = Omit<TProject, "metadata" | "scenes"> & {
	metadata: SerializedProjectMetadata;
	scenes: SerializedScene[];
	timelineViewState?: TTimelineViewState;
};

export interface SessionViewStateRecord {
	projectId: string;
	viewState: TTimelineViewState;
	updatedAt: string;
}

export type ProjectSnapshotSource = "autosave" | "manual";

export interface ProjectSnapshotRecord {
	/** Composite key: `${projectId}/${snapshotId}` so a single store fans
	 * across all projects while keeping per-project lookups cheap via prefix
	 * iteration. */
	id: string;
	projectId: string;
	snapshotId: string;
	savedAt: string;
	source: ProjectSnapshotSource;
	/** User-supplied label for named versions. Empty for autosaves. */
	label: string;
	/** Reserved for the multi-user seam — populated by the auth layer when
	 * accounts ship. Always empty in v1. */
	author: string;
	payload: SerializedProject;
}

export interface StorageConfig {
	projectsDb: string;
	mediaDb: string;
	savedSoundsDb: string;
	version: number;
}

// TypeScript type augmentation to add async iterator methods to FileSystemDirectoryHandle
// These methods are part of the File System Access API spec but may not be in all type definitions
declare global {
	interface FileSystemDirectoryHandle {
		keys(): AsyncIterableIterator<string>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
	}
}
