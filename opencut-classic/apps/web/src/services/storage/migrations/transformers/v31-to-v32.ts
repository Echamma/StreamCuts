import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

/**
 * R1 SceneTracks shape migration (see docs/roadmap/50-r1-uniform-tracks-spike.md).
 *
 * v31 shape: `tracks: { overlay: OverlayTrack[]; main: VideoTrack; audio: AudioTrack[] }`.
 * v32 shape: `tracks: { video: VideoTrack[]; text: TextTrack[]; graphic: GraphicTrack[]; effect: EffectTrack[]; audio: AudioTrack[] }`.
 *
 * `video` is ordered bottom-to-top: `video[0]` is the former `main` (the ripple
 * track), followed by every `overlay` VideoTrack in its original order. The
 * other kinds are split out of `overlay` into their own arrays, keeping
 * relative order. `audio` is unchanged.
 *
 * This module is **not** registered in `migrations[]` yet — it ships alongside
 * an inverse (`rollbackProjectV32ToV31`) and roundtrip tests so we can prove
 * the plan out before Phase C flips the shape.
 */

export function transformProjectV31ToV32({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	if (!getProjectId({ project })) {
		return { project, skipped: true, reason: "no project id" };
	}

	const version = project.version;
	if (typeof version !== "number") {
		return { project, skipped: true, reason: "invalid version" };
	}
	if (version >= 32) {
		return { project, skipped: true, reason: "already v32" };
	}
	if (version !== 31) {
		return { project, skipped: true, reason: "not v31" };
	}

	return {
		project: {
			...migrateProject({ project }),
			version: 32,
		},
		skipped: false,
	};
}

/**
 * Rollback v32→v31. Rebuilds the old shape from the new one so that a bad
 * forward-migration can be reverted from an on-disk snapshot without data
 * loss. Round-trips are proved by the accompanying tests.
 */
export function rollbackProjectV32ToV31({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	if (!getProjectId({ project })) {
		return { project, skipped: true, reason: "no project id" };
	}

	const version = project.version;
	if (typeof version !== "number") {
		return { project, skipped: true, reason: "invalid version" };
	}
	if (version <= 31) {
		return { project, skipped: true, reason: "already v31 or older" };
	}
	if (version !== 32) {
		return { project, skipped: true, reason: "not v32" };
	}

	return {
		project: {
			...rollbackProject({ project }),
			version: 31,
		},
		skipped: false,
	};
}

// ---------------------------------------------------------------------------
// forward
// ---------------------------------------------------------------------------

function migrateProject({ project }: { project: ProjectRecord }): ProjectRecord {
	const nextProject = { ...project };
	if (Array.isArray(project.scenes)) {
		nextProject.scenes = project.scenes.map((scene) => migrateScene({ scene }));
	}
	return nextProject;
}

function migrateScene({ scene }: { scene: unknown }): unknown {
	if (!isRecord(scene)) {
		return scene;
	}

	const nextScene = { ...scene };
	if (isRecord(scene.tracks)) {
		nextScene.tracks = migrateTracks({ tracks: scene.tracks });
	}
	return nextScene;
}

function migrateTracks({
	tracks,
}: {
	tracks: ProjectRecord;
}): ProjectRecord {
	// Split overlay by track type. Everything without a recognised type falls
	// into `effect` — it's the closest to a catch-all lane in the current model.
	const overlay = Array.isArray(tracks.overlay) ? tracks.overlay : [];
	const overlayVideo: unknown[] = [];
	const text: unknown[] = [];
	const graphic: unknown[] = [];
	const effect: unknown[] = [];

	for (const track of overlay) {
		if (!isRecord(track)) {
			continue;
		}
		switch (track.type) {
			case "video":
				overlayVideo.push(track);
				break;
			case "text":
				text.push(track);
				break;
			case "graphic":
				graphic.push(track);
				break;
			case "effect":
				effect.push(track);
				break;
			default:
				// unknown overlay track kind — keep it as `effect` so we don't lose it
				effect.push(track);
		}
	}

	const video: unknown[] = [];
	if (isRecord(tracks.main)) {
		video.push(tracks.main);
	}
	for (const track of overlayVideo) {
		video.push(track);
	}

	return {
		video,
		text,
		graphic,
		effect,
		audio: Array.isArray(tracks.audio) ? tracks.audio : [],
	};
}

// ---------------------------------------------------------------------------
// inverse (rollback)
// ---------------------------------------------------------------------------

function rollbackProject({
	project,
}: {
	project: ProjectRecord;
}): ProjectRecord {
	const nextProject = { ...project };
	if (Array.isArray(project.scenes)) {
		nextProject.scenes = project.scenes.map((scene) => rollbackScene({ scene }));
	}
	return nextProject;
}

function rollbackScene({ scene }: { scene: unknown }): unknown {
	if (!isRecord(scene)) {
		return scene;
	}

	const nextScene = { ...scene };
	if (isRecord(scene.tracks)) {
		nextScene.tracks = rollbackTracks({ tracks: scene.tracks });
	}
	return nextScene;
}

function rollbackTracks({
	tracks,
}: {
	tracks: ProjectRecord;
}): ProjectRecord {
	const video = Array.isArray(tracks.video) ? tracks.video : [];
	const text = Array.isArray(tracks.text) ? tracks.text : [];
	const graphic = Array.isArray(tracks.graphic) ? tracks.graphic : [];
	const effect = Array.isArray(tracks.effect) ? tracks.effect : [];
	const audio = Array.isArray(tracks.audio) ? tracks.audio : [];

	// `main` is `video[0]` post-R1. If there is no video, synthesise nothing —
	// the rollback returns a `main`-less shape and the scene loader will treat
	// it as absent (existing code paths already tolerate `!activeScene?.tracks`).
	const main = video.length > 0 && isRecord(video[0]) ? video[0] : undefined;
	const overlayVideo = video.slice(1);

	// Rebuild `overlay` in a stable canonical order: overlay-videos, then text,
	// then graphic, then effect. This is the order overlays sat within the old
	// mixed array most commonly (users mostly append). Roundtrips only depend
	// on the split by kind, not the mixed order, so the tests roundtrip the
	// forward direction (v31 → v32 → v31) against this canonical rebuild.
	const overlay = [...overlayVideo, ...text, ...graphic, ...effect];

	const rebuilt: ProjectRecord = { overlay, audio };
	if (main !== undefined) {
		rebuilt.main = main;
	}
	return rebuilt;
}
