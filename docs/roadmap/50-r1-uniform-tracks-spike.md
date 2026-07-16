# 50 — R1 Uniform-Tracks Migration Spike

**Status**: spike proposal, not yet accepted.
**Scope**: this document + the two additive modules that ship with it. No production behavior change; no consumer migrated yet.

Decides between the two options in [41 R1](./41-risks-and-open-questions.md#r1-single-main-track-model-vs-uniform-video-tracks), scopes the follow-on work, and delivers a first small step that de-risks the rest.

## 1. The shape today, in one paragraph

`SceneTracks` in [`opencut-classic/apps/web/src/timeline/types.ts`](../../opencut-classic/apps/web/src/timeline/types.ts) is a heterogeneous record:

```ts
interface SceneTracks {
  overlay: OverlayTrack[];   // typed overlays: Video | Text | Graphic | Effect
  main: VideoTrack;           // the one main video track
  audio: AudioTrack[];
}
```

The main video track is special: only `main` can host ripple, transitions between clips, and the "main scene duration" contract; overlay VideoTracks cannot. Every consumer that reaches into the scene knows this asymmetry — a ripgrep counts **79 files** referencing `SceneTracks` and roughly **117 direct field accesses** across `tracks.main`, `tracks.overlay`, and `tracks.audio`. Storage is at v31 (see [`services/storage/migrations/index.ts`](../../opencut-classic/apps/web/src/services/storage/migrations/index.ts)).

## 2. Recommended decision — Option (b), uniform video tracks

Chosen over (a) "keep `main`, upgrade overlays". Rationale:

- Every future per-track feature (COL-013 per-track grades, FAIR strips, EDIT-024 track locking, EDIT-025 linked clips, EDIT-014 multicam, FUS-001 layering) has to answer *"which track kind is this?"* under (a). Under (b) that question does not exist.
- The migration cost compounds later. Color grades and mixer strips both want to attach per-track data. If (b) ships after they do, every one of them needs its own migration too.
- Rollback is simple: `main = video[0]`, everything else appended.

### Target shape

```ts
interface SceneTracks {
  /** Uniform video tracks, ordered bottom-to-top by compositing z-order.
   *  `video[0]` is the ripple track (the former `main`); higher indices
   *  render on top. Empty means "no video". */
  video: VideoTrack[];
  text: TextTrack[];
  graphic: GraphicTrack[];
  effect: EffectTrack[];
  audio: AudioTrack[];
}
```

Video is the only kind that becomes uniform — Text/Graphic/Effect are already uniform among themselves in the current `overlay: OverlayTrack[]` mixed array. The spike proposes surfacing them as their own arrays (they already are, structurally; today they're just intermixed).

**Compositing order convention**: `video[0]` is the bottom. This matches Resolve's "V1 is the ripple track, higher tracks composite on top" and preserves the current `main`-under-`overlay` behavior at index 0. Same rule for text/graphic/effect within their own arrays.

**What ripple means in the new world**: v1 keeps ripple gated to `video[0]` — the "ripple track" is now explicit rather than implied by shape. EDIT-001 batches later can extend ripple to any chosen track without another migration.

**What "main scene" duration means**: `getProjectDurationFromScenes` today reads `mainScene.tracks` and calls `calculateTotalDuration` on all fields; that function already iterates every kind. No behavior change needed at the duration level — the migration is transparent to duration math.

## 3. Migration strategy — expand-contract, not big-bang

The 117 field accesses cannot flip in one PR without leaving `main` broken between commits. The plan is expand-contract:

**Phase A — introduce the seam** (this spike)
- Ship pure **view functions** that read the *current* shape and return the *target* shape's slices. Consumers can migrate to the views one at a time without any type change:
  - `getAllVideoTracks(tracks)` → `[main, ...overlay.filter(video)]`
  - `getMainVideoTrack(tracks)` → `main`
  - `getOverlayVideoTracks(tracks)` → `overlay.filter(video)`
  - `getTextTracks(tracks)` → `overlay.filter(text)`
  - `getGraphicTracks(tracks)` → `overlay.filter(graphic)`
  - `getEffectTracks(tracks)` → `overlay.filter(effect)`
  - `getAudioTracks(tracks)` → `audio`
- Ship the v31→v32 storage **transformer + its inverse** and a `V31toV32Migration` class, unregistered — so it's tested but inert until we flip.

**Phase B — migrate consumers to views** (one or more follow-on batches, mergeable each step)
- Sweep the 79 files, replacing raw field access with view calls. Because the views wrap the *current* shape today, each swap is a semantics-preserving refactor. Each batch: some files, tsc-clean, tests still green.
- The `updateTracks`/`updateSceneTracks` write path stays on the current shape throughout Phase B.

**Phase C — flip the type + wire the migration** (single small PR when Phase B is done)
- Change `SceneTracks` to the target shape.
- Rewrite the view functions to read the new shape.
- Register `V31toV32Migration` in `migrations[]`, bump `CURRENT_PROJECT_VERSION = 32`.
- Rewrite `buildDefaultScene` / `mergeSceneTracks` / `updateSceneTracks` to the new shape.
- Rewrite the write helpers in [`timeline/track-element-update.ts`](../../opencut-classic/apps/web/src/timeline/track-element-update.ts).
- Everything downstream continues to compile because no consumer touches the raw fields anymore.

**Phase D — cleanup**
- Delete the `getMainVideoTrack`/`getOverlayVideoTracks` split if they aren't ergonomically used anymore, or keep them; strip `main`-specific ripple gating where an explicit "ripple track id" field replaces it (that lands as EDIT-001 batches, not R1 itself).

**Snapshot rollback**: the app already runs a [snapshot manager](../../opencut-classic/apps/web/src/services/storage/) in the storage layer. Phase C's migration is prefaced by a snapshot; if the migration fails partway or produces an obviously bad shape (validators fire), the rollback path uses the inverse transformer to restore the pre-migration state. The inverse is shipped in this spike and tested.

## 4. Consumer inventory (for the follow-on scoping)

Ripgrep from this spike:

| Field access               | File count |
|----------------------------|-----------:|
| `tracks.main` (or `.main.`) |         40 |
| `tracks.overlay`            |         42 |
| `tracks.audio`              |         35 |
| `SceneTracks` (any mention) |         79 |

Estimated Phase-B batch count: **3–5**, grouped by subsystem, each mergeable independently:

1. **Read-path core**: `timeline/`, `commands/`, `core/managers/` — the write helpers, timeline-manager, scenes-manager. Biggest single batch.
2. **Renderer & playback**: `services/renderer/`, `preview/`, `core/managers/playback-manager.ts`.
3. **Audio**: `media/audio.ts`, `core/managers/audio-manager.ts`, `components/editor/panels/assets/views/audio-mixer.tsx`, mastering.
4. **Timeline UI**: `timeline/components/*`, `components/editor/panels/**` (properties/media/etc.).
5. **Tests + fixtures**.

Then Phase C is a single small flip PR.

## 5. What this spike ships

Two additive modules and this doc — no consumer migrated:

- [`opencut-classic/apps/web/src/timeline/scene-tracks-view.ts`](../../opencut-classic/apps/web/src/timeline/scene-tracks-view.ts) — the view functions above, implemented against the *current* shape. Tested.
- [`opencut-classic/apps/web/src/services/storage/migrations/transformers/v31-to-v32.ts`](../../opencut-classic/apps/web/src/services/storage/migrations/transformers/v31-to-v32.ts) — forward + inverse transformer with roundtrip tests. **Not registered** in `migrations[]`, so `CURRENT_PROJECT_VERSION` stays at 31.

If this PR is accepted, the compatibility surface lets Phase B start immediately. If it's rejected, nothing has to be reverted — nothing runtime-visible changed.

## 6. Explicit non-goals for this spike

- No consumer file changes. Nothing under `timeline/components/`, `services/renderer/`, `core/managers/` is touched.
- No `SceneTracks` type change.
- No `CURRENT_PROJECT_VERSION` bump; the v31→v32 migration is present but not registered.
- No renderer/compositor changes (R2 is separate).
- No new UI for creating video tracks (part of EDIT-001 batch after R1 lands).

## 7. Risks specific to R1 that this spike de-risks

- **Silent data loss on migration** — the shipped forward + inverse + roundtrip tests prove the transformer preserves the representable shape. The tests use realistic fixtures (multi-video-overlay, mixed kinds, empty scenes, missing fields).
- **Rollback plumbing** — the inverse function is shipped and tested here, not left for Phase C when it's most needed.
- **Consumer refactor cost** — the compatibility views make Phase B into a mechanical sweep instead of a coordinated flip.

## 8. R2 (binary-rendering rework) alignment

Untouched. The compositor/renderer isn't part of this spike. When Phase C lands, the renderer's own `main` vs `overlay` handling flips too, but it's a small, contained change inside the renderer's `resolve.ts` — not a redesign.
