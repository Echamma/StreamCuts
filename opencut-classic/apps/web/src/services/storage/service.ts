import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset } from "@/media/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import {
	type StorageCapacityCheckResult,
	StorageQuotaExceededError,
	evaluateStorageCapacity,
	isStorageQuotaExceededError,
	readStorageQuotaStatus,
} from "./quota";
import { mediaProxyStorageKey } from "./types";
import type {
	MediaAssetData,
	MediaAssetSource,
	ProjectSnapshotRecord,
	ProjectSnapshotSource,
	SessionViewStateRecord,
	StorageConfig,
	SerializedProject,
	SerializedScene,
} from "./types";
import type { SavedSoundsData, SavedSound, SoundEffect } from "@/sounds/types";
import {
	migrations,
	runStorageMigrations,
} from "@/services/storage/migrations";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { roundMediaTime } from "@/wasm";
import { measureSpanAsync } from "@/diagnostics/render-perf";
import { FILE_MEDIA_ASSET_SOURCE } from "@/media/asset-source";

function normalizeMediaAssetSource({
	source,
}: {
	source?: MediaAssetSource;
}): MediaAssetSource {
	return source ?? FILE_MEDIA_ASSET_SOURCE;
}

async function createMediaAssetUrl({
	file,
	type,
}: {
	file: File;
	type: MediaAsset["type"];
}): Promise<string> {
	if (type === "image" && (!file.type || file.type === "")) {
		try {
			const text = await file.text();
			if (text.trim().startsWith("<svg")) {
				const svgBlob = new Blob([text], { type: "image/svg+xml" });
				return URL.createObjectURL(svgBlob);
			}
		} catch {
			// Fall back to the original file object URL below.
		}
	}

	return URL.createObjectURL(file);
}

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

class StorageService {
	private projectsAdapter: IndexedDBAdapter<SerializedProject>;
	private savedSoundsAdapter: IndexedDBAdapter<SavedSoundsData>;
	private sessionViewStateAdapter: IndexedDBAdapter<SessionViewStateRecord>;
	private snapshotsAdapter: IndexedDBAdapter<ProjectSnapshotRecord>;
	private config: StorageConfig;
	private migrationsPromise: Promise<void> | null = null;

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			savedSoundsDb: "video-editor-saved-sounds",
			version: 1,
		};

		this.projectsAdapter = new IndexedDBAdapter<SerializedProject>({
			dbName: this.config.projectsDb,
			storeName: "projects",
			version: this.config.version,
		});

		this.savedSoundsAdapter = new IndexedDBAdapter<SavedSoundsData>({
			dbName: this.config.savedSoundsDb,
			storeName: "saved-sounds",
			version: this.config.version,
		});

		this.sessionViewStateAdapter = new IndexedDBAdapter<SessionViewStateRecord>({
			dbName: `${this.config.projectsDb}-session-view`,
			storeName: "session-view-state",
			version: this.config.version,
		});

		this.snapshotsAdapter = new IndexedDBAdapter<ProjectSnapshotRecord>({
			dbName: `${this.config.projectsDb}-snapshots`,
			storeName: "project-snapshots",
			version: this.config.version,
		});
	}

	private async ensureMigrations(): Promise<void> {
		if (this.migrationsPromise) {
			await this.migrationsPromise;
			return;
		}

		this.migrationsPromise = runStorageMigrations({ migrations }).then(
			() => undefined,
		);
		await this.migrationsPromise;
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const mediaAssetsAdapter = new OPFSAdapter(`media-files-${projectId}`);

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		const quotaStatus = await readStorageQuotaStatus();
		return evaluateStorageCapacity({
			requiredBytes: size,
			quotaStatus,
		});
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	private stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map((element) => {
					const { buffer: _buffer, ...rest } = element;
					return rest;
				}),
			})),
		};
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
			bookmarks: scene.bookmarks,
			createdAt: scene.createdAt.toISOString(),
			updatedAt: scene.updatedAt.toISOString(),
		}));

		const serializedProject: SerializedProject = {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				thumbnail: project.metadata.thumbnail,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: serializedScenes,
			currentSceneId: project.currentSceneId,
			settings: project.settings,
			version: project.version,
		};

		await measureSpanAsync({
			name: "storage.saveProject",
			fn: () =>
				this.projectsAdapter.set({
					key: project.metadata.id,
					value: serializedProject,
				}),
		});
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureMigrations();
		const serializedProject = await this.projectsAdapter.get(id);

		if (!serializedProject) return null;

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		const scenes =
			serializedProject.scenes?.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				tracks: scene.tracks,
				bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})) ?? [];

		const project: TProject = {
			metadata: {
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({ scenes }),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			},
			scenes,
			currentSceneId: serializedProject.currentSceneId || "",
			settings: serializedProject.settings,
			version: serializedProject.version,
			timelineViewState: serializedProject.timelineViewState,
		};

		return { project };
	}

	async saveSessionViewState({
		projectId,
		viewState,
	}: {
		projectId: string;
		viewState: TProject["timelineViewState"];
	}): Promise<void> {
		if (!viewState) {
			await this.deleteSessionViewState({ projectId });
			return;
		}

		await measureSpanAsync({
			name: "storage.saveSessionViewState",
			fn: () =>
				this.sessionViewStateAdapter.set({
					key: projectId,
					value: {
						projectId,
						viewState,
						updatedAt: new Date().toISOString(),
					},
				}),
		});
	}

	async loadSessionViewState({
		projectId,
	}: {
		projectId: string;
	}): Promise<TProject["timelineViewState"] | null> {
		const record = await this.sessionViewStateAdapter.get(projectId);
		return record?.viewState ?? null;
	}

	async deleteSessionViewState({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		await this.sessionViewStateAdapter.remove(projectId);
	}

	private serializeProjectForSnapshot({
		project,
	}: {
		project: TProject;
	}): SerializedProject {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
			bookmarks: scene.bookmarks,
			createdAt: scene.createdAt.toISOString(),
			updatedAt: scene.updatedAt.toISOString(),
		}));
		return {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				thumbnail: project.metadata.thumbnail,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: serializedScenes,
			currentSceneId: project.currentSceneId,
			settings: project.settings,
			version: project.version,
		};
	}

	async saveProjectSnapshot({
		project,
		snapshotId,
		source,
		label,
	}: {
		project: TProject;
		snapshotId: string;
		source: ProjectSnapshotSource;
		label?: string;
	}): Promise<ProjectSnapshotRecord> {
		const record: ProjectSnapshotRecord = {
			id: `${project.metadata.id}/${snapshotId}`,
			projectId: project.metadata.id,
			snapshotId,
			savedAt: new Date().toISOString(),
			source,
			label: label ?? "",
			author: "",
			payload: this.serializeProjectForSnapshot({ project }),
		};
		await this.snapshotsAdapter.set({ key: record.id, value: record });
		return record;
	}

	async listProjectSnapshots({
		projectId,
	}: {
		projectId: string;
	}): Promise<ProjectSnapshotRecord[]> {
		const ids = await this.snapshotsAdapter.list();
		const prefix = `${projectId}/`;
		const matching = ids.filter((id) => id.startsWith(prefix));
		const records: ProjectSnapshotRecord[] = [];
		for (const id of matching) {
			const record = await this.snapshotsAdapter.get(id);
			if (record) records.push(record);
		}
		return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
	}

	async getLatestProjectSnapshot({
		projectId,
	}: {
		projectId: string;
	}): Promise<ProjectSnapshotRecord | null> {
		const list = await this.listProjectSnapshots({ projectId });
		return list[0] ?? null;
	}

	async deleteProjectSnapshot({
		projectId,
		snapshotId,
	}: {
		projectId: string;
		snapshotId: string;
	}): Promise<void> {
		await this.snapshotsAdapter.remove(`${projectId}/${snapshotId}`);
	}

	async deleteAllProjectSnapshots({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const snapshots = await this.listProjectSnapshots({ projectId });
		for (const snapshot of snapshots) {
			await this.snapshotsAdapter.remove(snapshot.id);
		}
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureMigrations();
		const serializedProjects = await this.projectsAdapter.getAll();

		const metadata: TProjectMetadata[] = [];
		for (const serializedProject of serializedProjects) {
			if (
				typeof serializedProject !== "object" ||
				serializedProject === null ||
				typeof serializedProject.metadata !== "object" ||
				serializedProject.metadata === null
			) {
				console.warn(
					"[storage] Skipping malformed project entry (missing metadata):",
					serializedProject,
				);
				continue;
			}

			metadata.push({
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({
							scenes: (serializedProject.scenes ?? []) as unknown as TScene[],
						}),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			});
		}

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await Promise.all([
			this.projectsAdapter.remove(id),
			this.deleteSessionViewState({ projectId: id }),
			this.deleteAllProjectSnapshots({ projectId: id }),
		]);
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });
		const source = normalizeMediaAssetSource({ source: mediaAsset.source });

		const metadata: MediaAssetData = {
			id: mediaAsset.id,
			name: mediaAsset.name,
			type: mediaAsset.type,
			size: mediaAsset.size,
			lastModified: mediaAsset.lastModified,
			width: mediaAsset.width,
			height: mediaAsset.height,
			duration: mediaAsset.duration,
			fps: mediaAsset.fps,
			hasAudio: mediaAsset.hasAudio,
			thumbnailUrl: mediaAsset.thumbnailUrl,
			ephemeral: mediaAsset.ephemeral,
			socialCopy: mediaAsset.socialCopy,
			folderId: mediaAsset.folderId,
			sceneId: mediaAsset.sceneId,
			attributes: mediaAsset.attributes,
			hasProxy: mediaAsset.proxyFile !== undefined,
			source,
		};

		try {
			if (source.kind === "file") {
				await mediaAssetsAdapter.set({
					key: mediaAsset.id,
					value: mediaAsset.file,
				});
			}
			// The proxy is stored beside the master under its own key, so it is
			// cleaned up with the project and never confused with the original.
			if (mediaAsset.proxyFile) {
				await mediaAssetsAdapter.set({
					key: mediaProxyStorageKey(mediaAsset.id),
					value: mediaAsset.proxyFile,
				});
			}
			await mediaMetadataAdapter.set({
				key: mediaAsset.id,
				value: metadata,
			});
		} catch (error) {
			try {
				if (source.kind === "file") {
					await mediaAssetsAdapter.remove(mediaAsset.id);
				}
			} catch {
				// Ignore cleanup failures so the original storage error is preserved.
			}

			if (source.kind === "file" && this.isQuotaExceededError({ error })) {
				throw new StorageQuotaExceededError({
					requiredBytes: mediaAsset.size,
				});
			}

			throw error;
		}
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const [metadata, file] = await Promise.all([
			mediaMetadataAdapter.get(id),
			mediaAssetsAdapter.get(id),
		]);

		if (!metadata) return null;

		const proxyFile = metadata.hasProxy
			? ((await mediaAssetsAdapter.get(mediaProxyStorageKey(id))) ?? undefined)
			: undefined;

		const source = normalizeMediaAssetSource({ source: metadata.source });
		const resolvedFile =
			source.kind === "file"
				? file
				: await mediaAssetsAdapter.get(source.rootSourceAssetId);
		if (!resolvedFile) return null;

		const url = await createMediaAssetUrl({
			file: resolvedFile,
			type: metadata.type,
		});

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			size: metadata.size,
			lastModified: metadata.lastModified,
			file: resolvedFile,
			url,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			fps: metadata.fps,
			hasAudio: metadata.hasAudio,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			socialCopy: metadata.socialCopy,
			folderId: metadata.folderId,
			sceneId: metadata.sceneId,
			attributes: metadata.attributes,
			hasProxy: metadata.hasProxy,
			proxyFile,
			source,
		};
	}

	/**
	 * Re-acquire a fresh File handle for a stored media asset straight from
	 * OPFS. The File snapshots cached on in-memory assets (captured at project
	 * load) can go stale and throw NotReadableError when read much later, so
	 * callers that need to read raw bytes on demand should re-fetch here.
	 */
	async loadMediaAssetFile({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<File | null> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });
		const metadata = await mediaMetadataAdapter.get(id);
		if (!metadata) {
			return null;
		}

		const source = normalizeMediaAssetSource({ source: metadata.source });
		return source.kind === "file"
			? mediaAssetsAdapter.get(id)
			: mediaAssetsAdapter.get(source.rootSourceAssetId);
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const mediaItems: MediaAsset[] = [];

		for (const id of mediaIds) {
			const item = await this.loadMediaAsset({ projectId, id });
			if (item) {
				mediaItems.push(item);
			}
		}

		return mediaItems;
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });
		const metadata = await mediaMetadataAdapter.get(id);
		const source = normalizeMediaAssetSource({ source: metadata?.source });

		await Promise.all([
			source.kind === "file"
				? mediaAssetsAdapter.remove(id)
				: Promise.resolve(),
			mediaMetadataAdapter.remove(id),
		]);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaMetadataAdapter.clear(),
			mediaAssetsAdapter.clear(),
		]);
	}

	async clearAllData(): Promise<void> {
		await Promise.all([
			this.projectsAdapter.clear(),
			this.sessionViewStateAdapter.clear(),
			this.snapshotsAdapter.clear(),
		]);
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();

		return {
			mediaItems: mediaIds.length,
		};
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		try {
			const savedSoundsData = await this.savedSoundsAdapter.get("user-sounds");
			return (
				savedSoundsData || {
					sounds: [],
					lastModified: new Date().toISOString(),
				}
			);
		} catch (error) {
			console.error("Failed to load saved sounds:", error);
			return { sounds: [], lastModified: new Date().toISOString() };
		}
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) {
				return; // Already saved
			}

			const savedSound: SavedSound = {
				id: soundEffect.id,
				name: soundEffect.name,
				username: soundEffect.username,
				previewUrl: soundEffect.previewUrl,
				downloadUrl: soundEffect.downloadUrl,
				duration: soundEffect.duration,
				tags: soundEffect.tags,
				license: soundEffect.license,
				savedAt: new Date().toISOString(),
			};

			const updatedData: SavedSoundsData = {
				sounds: [...currentData.sounds, savedSound],
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to save sound effect:", error);
			throw error;
		}
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			const updatedData: SavedSoundsData = {
				sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to remove saved sound:", error);
			throw error;
		}
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		try {
			const currentData = await this.loadSavedSounds();
			return currentData.sounds.some((sound) => sound.id === soundId);
		} catch (error) {
			console.error("Failed to check if sound is saved:", error);
			return false;
		}
	}

	async clearSavedSounds(): Promise<void> {
		try {
			await this.savedSoundsAdapter.remove("user-sounds");
		} catch (error) {
			console.error("Failed to clear saved sounds:", error);
			throw error;
		}
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.isIndexedDBSupported() && this.isOPFSSupported();
	}
}

export const storageService = new StorageService();
export { StorageService };
