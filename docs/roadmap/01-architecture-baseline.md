# 01 — Architecture Baseline (current state)

The verified current state of StreamCuts, at commit `ffd6575`. Every inventory row in `10`–`17` anchors to a section here instead of re-explaining the codebase. Paths are repo-root-relative.

## 1. Monorepo topology

- `opencut-classic/` — the OpenCut-fork web editor. Turborepo + Bun; app at `opencut-classic/apps/web` (Next.js 16.1, React 19, TypeScript 5.8, Tailwind CSS v4); Rust workspace at `opencut-classic/rust/` publishing the `opencut-wasm` npm package; a stub GPUI desktop shell at `opencut-classic/apps/desktop`.
- `backend/long-to-short/` — local NestJS 11 service on `:4000`: faster-whisper transcription (warm Python worker, `backend/long-to-short/python/transcribe.py`), Gemini clip planning, ffmpeg-static rendering. Jobs under `backend/long-to-short/data/jobs/<uuid>/`.
- `launcher/` — Rust Windows launcher (`launcher/src/main.rs`): starts backend `:4000` + frontend `:3000` with a Job Object (kill-on-close), opens the browser. Start-only; artifacts prepared by `script/prepare-windows-launcher.ps1`.
- Product shape: **local-first Windows tool**. Postgres/Drizzle + better-auth are scaffolded but inactive (only the feedback API touches the DB); project data lives client-side (see §14).

## 2. Editor core (manager facade)

`opencut-classic/apps/web/src/core/index.ts` — an `EditorCore` singleton owning 14 managers in `opencut-classic/apps/web/src/core/managers/`: `audio-manager`, `clipboard-manager`, `commands`, `diagnostics-manager`, `media-manager`, `playback-manager`, `project-manager`, `renderer-manager`, `save-manager`, `scenes-manager`, `selection-manager`, `session-view-state-store`, `snapshot-manager`, `timeline-manager`. React binds via `useSyncExternalStore` scoped hooks in `opencut-classic/apps/web/src/editor/use-editor.ts` (`useTimeline`, `usePlayback`, `useSelection`, …). Zustand stores exist **only for UI preferences** (panel sizes, snapping toggles, per-panel view state) — never for document state.

## 3. Time model

`MediaTime` is a branded integer tick count with `TICKS_PER_SECOND = 120000` (divisible by all common frame rates), defined in `opencut-classic/rust/crates/time/src/media_time.rs` and mirrored at `opencut-classic/apps/web/src/wasm/media-time.ts`. `FrameRate` is a rational `{numerator, denominator}`. All timeline math is exact integer arithmetic; rounding/timecode parsing crosses into Rust. **Every roadmap feature that manipulates time (retime, fades, transitions, interchange) must stay on this integer grid.**

## 4. Timeline model — and the single-main-track constraint

`opencut-classic/apps/web/src/timeline/types.ts`:

- A project has multiple **scenes** (`TScene`); each scene owns `SceneTracks`:

```ts
export interface SceneTracks {
    overlay: OverlayTrack[];   // video | text | graphic | effect — stacked above main
    main: VideoTrack;          // exactly ONE primary video track
    audio: AudioTrack[];
}
```

- **7 element types**: video, image, text, sticker, graphic, effect (adjustment-layer style), audio — all with `startTime`/`duration`/`trimStart`/`trimEnd` in `MediaTime`, a generic `params` bag, and optional keyframe `animations`.
- `TrackTransition` — transitions between **adjacent clips on video tracks** only.
- `RetimeConfig { rate; maintainPitch? }` — **constant-rate** 0.01×–5×.

> **⚠ R1 — the headline divergence.** Resolve has unlimited uniform video tracks; StreamCuts has one `main` video track plus typed overlays. Overlays cannot ripple, take transitions, or act as full peers of `main`. Several inventory rows (multicam, Fusion-lite layering, track-targeted grading) depend on resolving this — see [41-risks-and-open-questions.md](./41-risks-and-open-questions.md) R1.

## 5. Undo / commands

Command-pattern history in `opencut-classic/apps/web/src/commands/` (`base-command.ts`, `batch-command.ts`, domain trees under `commands/timeline/`, `commands/scene/`, `commands/media/`), executed through `core/managers/commands.ts`. Ripple is applied automatically around commands when enabled (`applyRippleIfEnabled`). New edit operations (roll/slip/slide, markers, grouping) are **additive command classes** — the infrastructure needs no change.

## 6. Keyframes & curve editor — MATURE (the biggest reusable asset)

`opencut-classic/apps/web/src/animation/` + `opencut-classic/apps/web/src/timeline/components/graph-editor/` (`bezier-graph.tsx`, `easing-presets.ts`, `custom-presets-store.ts`). Three channel kinds (number, color, discrete); registry of animatable property paths (`opencut-classic/apps/web/src/animation/types.ts`); per-keyframe bezier curves; effect params are keyframable. Docs: `opencut-classic/docs/keyframes.md`. **Color curves UI (COL), audio automation lanes (FAIR), and variable retime curves (EDIT) should all reuse these components.**

## 7. Rendering pipeline (preview = export)

One node-tree renderer serves preview and export, in `opencut-classic/apps/web/src/services/renderer/`:

1. `scene-builder.ts` builds a typed node tree — 12 node types in `services/renderer/nodes/`: `base-node`, `root-node`, `video-node`, `image-node`, `text-node`, `sticker-node`, `graphic-node`, `color-node`, `blur-background-node`, `effect-layer-node`, `transition-node`, `visual-node`.
2. `resolve.ts` resolves nodes at a timestamp (decodes frames, evaluates animated params).
3. `compositor/frame-descriptor.ts` rasterizes text/masks/graphics to 2D canvases and emits a `FrameDescriptor` (layers with transform, opacity, blend mode, effect passes, mask, reframe).
4. `compositor/wasm-compositor.ts` bridges to Rust wgpu (`opencut-classic/rust/crates/{gpu,compositor,effects,masks}`), running on the **WebGL2 backend** in-browser. 17 Photoshop-style blend modes (`rust/crates/compositor/src/blend_mode.rs`); content-hash texture caching.
5. Effects run as GPU passes: `services/renderer/gpu-renderer.ts` → WGSL shaders in `rust/crates/effects/src/shaders/`.

**Effects registry**: architecture complete (`opencut-classic/apps/web/src/effects/types.ts` — multi-pass `EffectDefinition`; docs at `opencut-classic/docs/effects-renderer.md`) but **only gaussian blur is registered** (`opencut-classic/apps/web/src/effects/definitions/index.ts` → `blur.ts`). This registry is the insertion point for the entire Color page.

> **⚠ R2.** `opencut-classic/README.md` warns preview/effects/export are being reworked with a "binary rendering approach." Renderer-touching roadmap items are flagged.

## 8. Playback / decode

Frame-accurate WebCodecs decode via mediabunny `CanvasSink` (`opencut-classic/apps/web/src/services/video-cache/service.ts`): **LRU cache of ≤ 6 sinks**, next-frame prefetch, latest-wins seeking. No HTML `<video>` elements. The 6-sink ceiling is why multicam requires proxies (see `40` §7).

## 9. Export

`opencut-classic/apps/web/src/services/renderer/scene-exporter.ts` — mediabunny `Output` fed by the compositor canvas through a WebCodecs `VideoEncoder`. Containers: **mp4 (H.264 + AAC)** and **webm (VP9 + Opus)**; quality tiers drive a bits-per-pixel bitrate model; streams to disk via `FileSystemWritableFileStream` or buffers in memory. 7 platform presets in `opencut-classic/apps/web/src/export/presets.ts` (TikTok, Instagram Reels/Square/Portrait, YouTube Shorts/1080p/4K). **Single job at a time — no queue, no background render.**

## 10. Audio

`opencut-classic/apps/web/src/core/managers/audio-manager.ts` — Web Audio API: `AudioContext`, master gain, per-clip buffer scheduling, mute. Per-clip **volume in dB is keyframable** with an automation line on clips (`opencut-classic/apps/web/src/timeline/components/audio-volume-line.tsx`). Source-audio separation (`timeline/audio-separation/`) and silence detection/removal (`commands/timeline/element/remove-silence.ts`) exist.

**Does NOT exist**: pan, clip fade handles, per-track mixer/channel strips, buses, meters, loudness measurement, EQ, dynamics. An "audio-mixer" tab key exists in the assets panel but has no real mixer behind it.

## 11. Transitions

`opencut-classic/apps/web/src/transitions/` — extensible registry (`registry.ts`), **4 built-ins** in `transitions/definitions/`: `crossfade`, `fade-black`, `wipe-left`, `wipe-right`. 2D-canvas rendered via `TransitionDefinition.render({from, to, progress})`, adjacent-clip-only on video tracks. Docs: `opencut-classic/docs/transitions.md`.

## 12. Text, captions & subtitles

- **Text elements — mature**: font family/size/weight/style, color, align, decoration, letter-spacing, line-height, background pill (`opencut-classic/apps/web/src/text/`, rendered by `services/renderer/nodes/text-node.ts`).
- **Captions**: SRT + ASS import/export (`opencut-classic/apps/web/src/subtitles/srt.ts`, `ass.ts`), caption list + style panel.
- **Word-by-word animation — schema-only (dormant quick win)**: `opencut-classic/apps/web/src/subtitles/animation/` defines 6 modes (none/wordHighlight/pop/bounce/typewriter/karaokeLine) and **6 baked presets** (Beast, Reels, Hormozi, Subtitle, Words, ASMR) with tested active-word helpers — but `seedBakedCaptionPresets()` in `subtitles/caption-style-presets-store.ts` **has no caller**, and the renderer does not consume the animation config. Wiring this is EDIT-012.
- **Two transcription stacks**: in-browser Whisper (`opencut-classic/apps/web/src/transcription/`, transformers.js + onnxruntime-web, WebGPU for large-v3-turbo) and backend faster-whisper (§16). Consolidation decision = risk R7.

## 13. Masks & saliency

- **Masks — mature** (`opencut-classic/apps/web/src/masks/`, `opencut-classic/rust/crates/masks`): 8 built-in shapes (split, cinematic-bars, rectangle, ellipse, heart, diamond, star, text) + freeform bezier (`masks/freeform/`), GPU feathering via jump-flood/SDF WGSL, stroke, invert, interactive handles. **Power windows (COL) and roto (FUS) are mask reuse, not new subsystems.**
- **Saliency auto-reframe — dormant quick win**: `opencut-classic/rust/crates/saliency` (motion-energy analyzer, smoothed anchor, 5 unit tests) is done; `opencut-classic/apps/web/src/saliency/runner.ts` walks frames at 4 Hz and emits `reframe.x/.y` keyframes — but **has no caller**. Reframe params (`reframe.x/y/scale`) are already honored end-to-end by the compositor (`opencut-classic/apps/web/src/rendering/reframe.ts`). Wiring this is EDIT-016.

## 14. Storage, autosave & recovery — MATURE

`opencut-classic/apps/web/src/services/storage/service.ts` — hybrid **OPFS** (raw media files per project) + **IndexedDB** (projects, metadata, snapshots, view state). Debounced main save (800 ms, `core/managers/save-manager.ts`); additive snapshots every 5 s + crash-recovery candidate + named versions (`core/managers/snapshot-manager.ts`); **34 schema migrations** (`services/storage/migrations/transformers/`). Any timeline-model change (R1, markers, groups) lands as migration ~#35 in this lineage.

## 15. UI layer

- **Layout**: `react-resizable-panels`. `opencut-classic/apps/web/src/panels/layout.ts` defines `PANEL_CONFIG` (tools 25 / preview 50 / properties 25 / mainContent 50 / timeline 50); live sizes persisted by `opencut-classic/apps/web/src/editor/panel-store.ts` (Zustand persist key `panel-sizes`, **version 2** with migration). Editor page: `opencut-classic/apps/web/src/app/editor/[project_id]/page.tsx`; hard mobile gate < 1024px (`components/editor/mobile-gate.tsx`).
- **Four panels**: left Assets (`components/editor/panels/assets/index.tsx`) with **14 vertical tabs** (`TAB_KEYS` in `assets-panel-store.tsx`: media, sounds, audio-mixer, text, stickers, effects, transitions, captions, adjustment, boss, summarize, long-to-short, socials, settings); center Preview (wgpu canvas, `apps/web/src/preview/components/index.tsx`); right Properties (registry-driven per element type, `components/editor/panels/properties/`); bottom Timeline (`apps/web/src/timeline/components/index.tsx` — toolbar, ruler, tracks, playhead, box-select, graph editor).
- **Actions system — mature**: `opencut-classic/apps/web/src/actions/definitions.ts` (~35 actions: JKL, frame step, split variants, snapping, history…), **rebindable at runtime** with conflict detection and persisted keybindings (migrations v2→v7), shortcuts dialog. Docs: `opencut-classic/docs/actions.md`. New pages/panels must register actions here, not ad-hoc key handlers.

## 16. Backend (`backend/long-to-short/`)

NestJS on `:4000`, local only. Controllers: `long-to-short` (one-shot pipeline + clip download + Windows folder reveal), `boss` (upload → transcribe → Gemini plan-cuts → ffmpeg render of chapters + vertical shorts → summarize), `transcription` (faster-whisper with per-job device `auto|cuda|cpu` + model picker; strict error surfacing on explicit device; NVIDIA DLL registration for Windows GPU). ffmpeg via `ffmpeg-static` — this process is the **`backend-ffmpeg` feasibility class**: pro-codec transcode, proxy generation, scene detection, and heavy AI all belong here. Known wart: two different default Gemini model strings between `boss.service.ts` and `long-to-short.service.ts`.

## 17. Design-system state

`opencut-classic/apps/web/src/app/globals.css` is the single token source (Tailwind v4 CSS-first — **no** `tailwind.config.js`):

- Brand: `--primary: hsl(200, 90%, 52%)` (line 18) — sky blue, kept per user decision.
- `@theme inline` (line 148) maps tokens to utilities; compact type scale (`--text-base: 0.92rem`); radius lg/md/sm = .82/.65/.35rem.
- **Dual surface layer**: `.panel` (line 52) and `.dark .panel` (line 102) re-override background/card/muted/accent/border — a 4-way theme matrix to maintain.
- shadcn/ui `new-york`, 45 primitives in `components/ui/`; icons from **four** sources (hugeicons primary, lucide, react-icons, custom `Oc*` SVGs); Inter via `next/font`.

**Known debt** (fix list = `21` §7): ~58 hardcoded colors in 17 files (element colors in `opencut-classic/apps/web/src/timeline/components/theme.ts`; bespoke export gradient `#2567EC→#37B6F7` in `components/editor/export-button.tsx`); no z-index/shadow/spacing tokens (raw `z-10`…`z-999`); `Button` diverged from shadcn (10 variants, inverted default, no `primary`); two toast systems (sonner + toast); dead dep `@hello-pangea/dnd`; bug `"elements selected.0"` at `components/editor/panels/properties/index.tsx:37`; shipped placeholders ("Adjustment view coming soon", "Freeze frame (coming soon)").

## 18. Constraints & policies

- **Rust-first** (`opencut-classic/AGENTS.md`): non-UI business logic migrates to `opencut-classic/rust/crates/*`; `apps/*` are replaceable UI shells. Roadmap boundary proposal: *engine math + parsers in crates; interaction state in TS* (risk R3).
- **Rendering rework** (risk R2): keep renderer work additive (new registry entries, new nodes) until the binary-rendering plan is aligned.
- **wgpu on WebGL2**: no compute shaders in-browser unless the WebGPU adapter is enabled — see `40` §2 for the scopes implication. Target user runs Chromium on Windows/NVIDIA, where WebGPU is available.
- **a11y**: `eslint-plugin-jsx-a11y` recommended is enforced; new UI must pass it.
