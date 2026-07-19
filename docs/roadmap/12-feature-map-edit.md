# 12 — Feature Map: Edit Page

**Resolve's Edit page** is the conventional NLE: multi-track timeline, the full trim suite, markers, groups/compounds, speed tools, transitions, titles, captions, multicam.

**StreamCuts today: the strongest area, with sharp gaps.** Split/trim/move/ripple/multi-select/copy-paste are solid on a command-pattern undo system ([baseline §4–5](./01-architecture-baseline.md#4-timeline-model--and-the-single-main-track-constraint)); keyframing is mature. Missing: roll/slip/slide, persistent groups, markers-with-notes, variable speed, multicam — and the **single-main-track model** (R1) caps how far "multi-track editing" can go without a migration.

## Timeline structure

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-001 | Multi-track video timeline (uniform V1…Vn) | PARTIAL — one `main` VideoTrack + typed overlay tracks | `timeline/types.ts` `SceneTracks` | Execute R1: migrate to uniform `VideoTrack[]` with explicit compositing order (storage migration ~#35, commands, scene-builder, timeline UI). 1-week spike first — see [41 R1](./41-risks-and-open-questions.md) | browser-native (rust-wgsl for compositor order) | XL | 2 |
| EDIT-024 | Track locking & clip disable | PARTIAL — per-element `hidden`/mute exist; no track lock | `timeline/types.ts` track interfaces | `locked` flag on tracks honored by drag/drop/commands; UI lock toggle in track labels | browser-native | S | 2 |
| EDIT-025 | Linked audio/video clips | PARTIAL — source-audio separation toggle exists (`timeline/audio-separation/`) | `commands/timeline/` | Explicit link groups so A/V pairs move/trim together after separation; groundwork for EDIT-006 | browser-native | M | 2 |
| EDIT-026 | Safe areas / guides | MISSING | `apps/web/src/preview/` overlay layers | Title/action-safe + aspect guides (9:16 crop preview pairs well with reframe); toggle in preview toolbar | browser-native | S | 1 |

### Design note EDIT-001 (R1 execution)

Do the migration **before** color/audio features attach per-track data (grades, mixer strips), or every later feature pays the migration twice. Overlays stay as a concept only if they map cleanly to plain tracks; transitions and ripple must work on all video tracks afterward. Ship with snapshot-based rollback (snapshot manager exists).

## Trim suite

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-002 | Roll / slip / slide trims | MISSING | `commands/timeline/` + `timeline/controllers/resize-controller.ts` | Three new command classes + modifier-key drag modes + keyboard nudge variants; preview feedback in the timeline | browser-native | M–L | 1 |
| EDIT-003 | Ripple edit / ripple delete | HAVE | `apps/web/src/ripple/` (`applyRippleIfEnabled`) | Keep; extend to all video tracks with EDIT-001 | — | — | — |
| EDIT-004 | Dynamic trim / JKL trim mode | PARTIAL — JKL playback exists in actions | `actions/definitions.ts`, `core/managers/playback-manager.ts` | Trim-mode toggle where JKL rolls the active edit point with audio scrub | browser-native | M | 4 |

## Organization

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-005 | Markers with notes, colors, durations | HAVE (timeline-level) — scene `bookmarks` are already full markers: `{time, note?, color?, duration?}`, double-click popover editor (note/color/duration/delete), drag+snap, duration ranges on the ruler, note-on-preview, undoable CRUD commands. *(2026-07-14 audit corrected this from the original "MISSING" estimate.)* | `timeline/bookmarks/` (`utils.ts`, `components/bookmarks.tsx`, `preview-overlay-source.tsx`, commands `commands/scene/*-bookmark.ts`) | Remaining gaps only: a marker-**list** panel (jump-to navigation) and **clip**-level markers (bookmarks are scene-scoped). No storage migration needed — the schema already carries the fields | browser-native | S (list) / M (clip markers) | 3 |
| EDIT-006 | Persistent clip groups | MISSING — group-move is transient multi-select | `timeline/group-move/`, `commands/timeline/` | `groupId` on elements + group/ungroup commands; selection expands to group; needed by COL-013 | browser-native | M | 3 |
| EDIT-007 | Compound clips / nested timelines | MISSING | scenes already exist (`core/managers/scenes-manager.ts`) | Compound = a scene referenced as a timeline element (design note below) | browser-native (renderer ⚠) | L | 3 |
| EDIT-008 | Take selector | MISSING | element `params` bag | Element holds alternate media sources + active index; properties-panel switcher | browser-native | M | 4 |
| EDIT-022 | Match frame / edit index | MISSING | playback + media managers | Match-frame action (playhead → source position in media panel); edit-index table view of all cuts | browser-native | S–M | 4 |
| EDIT-027 | Copy/paste attributes | PARTIAL — copy/paste + paste-keyframes exist | `commands/timeline/clipboard/paste-keyframes.ts` | Selective paste dialog (transform / effects / grade / retime / animations) | browser-native | M | 3 |

### Design note EDIT-007 (compound clips)

A compound clip is a `SceneRefElement` pointing at a (possibly hidden) scene, rendered by recursing `scene-builder.ts` into the referenced scene with a time offset — the renderer is already a node tree, so nesting is structurally natural. ⚠ rework-collision (R2): agree the recursion contract with the binary-rendering plan before building. Guard against reference cycles at command level.

## Speed & time

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-009 | Constant speed change (with pitch preserve) | HAVE | `apps/web/src/retime/` (0.01×–5×, soundtouchjs) | Keep | — | — | — |
| EDIT-010 | Speed ramps / variable retime | PARTIAL — constant-only `RetimeConfig` | `retime/rate.ts`, animation system | Piecewise-monotonic tick remap curve per [40 §5](./40-technical-feasibility.md#5-variable-retime-math); curve edited in the existing graph editor; constant becomes the 2-point case | browser-native | L | 4 |
| EDIT-021 | Freeze frame | MISSING — disabled "coming soon" button shipped | timeline toolbar; retime infra | Zero-rate segment of EDIT-010, or interim: extract still → image element | browser-native | S (after EDIT-010) | 4 |
| EDIT-011 | Stabilization | MISSING | `backend/long-to-short/` ffmpeg (vidstab) or `rust/crates/` | v1 = backend two-pass vidstab producing a stabilized proxy/replacement; in-browser smoothing of reframe keyframes as cheap alternative | backend-ffmpeg (rust-wgsl later) | M | 4 |

## Motion & framing

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-013 | Keyframe animation + curve editor | HAVE — mature | `animation/`, `timeline/components/graph-editor/` | Keep; it's the reuse substrate for COL curves, FAIR automation, EDIT-010 | — | — | — |
| EDIT-023 | Transform / position animation | HAVE | transform + `reframe.x/y/scale` params, keyframable | Keep | — | — | — |
| EDIT-016 | Auto-reframe (16:9 → 9:16) | PARTIAL — **dormant quick win**: saliency crate done+tested, runner has no caller | `rust/crates/saliency`, `apps/web/src/saliency/runner.ts` | Wire `analyzeMediaForReframe` to a "Auto-reframe" action + progress UI. R4 resolved local-only (2026-07-19): `SaliencyAnalyzer` resolves via the local `file:rust/wasm/pkg` override — no npm publish needed | rust-wgsl (wiring is browser-native) | S–M | 1 |

## Text & captions

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-017 | Titles & Text+ (animated title templates) | PARTIAL — static text is mature | `apps/web/src/text/`, `nodes/text-node.ts` | Title templates = text presets + baked keyframe sets; full motion-title editor belongs to FUS-008 | browser-native | L | 4 |
| EDIT-018 | Subtitles / closed captions (import/export/edit) | HAVE | `subtitles/srt.ts`, `ass.ts`, caption panels | Keep; burn-in on export = DEL-006 |  — | — | — |
| EDIT-012 | Word-by-word caption animation (presets) | PARTIAL — **dormant quick win**: schema + 6 baked presets + tested helpers exist; renderer never consumes; `seedBakedCaptionPresets()` never called | `subtitles/animation/`, `subtitles/caption-style-presets-store.ts`, `nodes/text-node.ts` | Call the seeder; render active-word state in text-node per animation config; preset picker in caption style panel | browser-native (renderer ⚠) | S–M | 1 |

## Transitions & generators

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-015 | Video transitions library | PARTIAL — 4 built-ins (crossfade, fade-black, wipe-left/right) | `transitions/definitions/`, registry | Batch 1 (P1): dip-to-white, slide, push, zoom, blur-through — S each on the 2D-canvas registry. Batch 2 (P3): GPU transition node for iris/3D-ish (⚠ R2) | browser-native → rust-wgsl | S each / M batch | 1 / 3 |
| EDIT-019 | Adjustment clips | PARTIAL — renderer support exists (`nodes/effect-layer-node.ts`); assets tab shows "coming soon" | `components/editor/panels/assets/` adjustment view | Ship the UI: drag adjustment element onto overlay/effect track; effects+grades apply to layers below (pairs with COL-001) | browser-native | M | 3 |
| EDIT-020 | Generators (solids, gradients, test patterns) | PARTIAL — solid/gradient via `color-node` + gradients library | `nodes/color-node.ts`, `apps/web/src/gradients/` | Add SMPTE bars / grid / countdown as parametric generator elements | browser-native | S | 3 |

## Multicam

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| EDIT-014 | Multicam editing | MISSING | depends MED-005 (proxies), MED-007 (audio sync), EDIT-001 (R1) | Multicam clip = synced source group; viewer grid cuts write angle-switch edits; proxies mandatory per [40 §7](./40-technical-feasibility.md#7-decode-pressure--multicam) | browser-native | XL | 4 |

## Rollup

- Rows: 27 → HAVE 5 · PARTIAL 12 · MISSING 10 · OUT 0
- Phase 1: EDIT-002 (roll/slip/slide), EDIT-005 (markers), EDIT-012 (caption animation wiring), EDIT-016 (auto-reframe wiring), EDIT-026 (safe areas), EDIT-015 batch 1 — two of these are dormant features that only need wiring, the cheapest wins in the entire roadmap.
- The expensive structural item is EDIT-001 (R1) in Phase 2; schedule nothing track-schema-dependent before it.
