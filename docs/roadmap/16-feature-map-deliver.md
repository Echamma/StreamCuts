# 16 — Feature Map: Deliver Page

**Resolve's Deliver page** is a render station: a queue of jobs, a wide codec matrix, presets, range renders, burn-ins, and upload targets.

**StreamCuts today**: a high-quality **single-job** exporter ([baseline §9](./01-architecture-baseline.md#9-export)) — `scene-exporter.ts` (WebCodecs → mediabunny, mp4 H.264+AAC / webm VP9+Opus, 7 social presets incl. 4K, streams to disk). No queue, no background render, no pro codecs. The local backend's ffmpeg is an unused deliver asset today.

## Design note DEL-001: the render queue

A `RenderQueueManager` (new, `opencut-classic/apps/web/src/core/managers/`) owning an ordered job list `{scene(s), preset, range, output target, status, progress}`, executing jobs serially through the existing `SceneExporter` (which already emits progress/complete/error/cancelled events). Persist queue in IndexedDB so a reload restores pending jobs. UI = the Deliver page's primary surface (`20` §4). Serial-first is deliberate: parallel encodes fight for the same hardware encoder. Background/parallel rendering is DEL-010's design question, not v1.

## Design note DEL-003: the pro-codec path

Browser can't encode ProRes/DNxHR/MXF ([40 §1](./40-technical-feasibility.md#1-codecs--containers)). Route: client renders a high-bitrate H.264/VP9 **master** via the current path → POST to `backend/long-to-short/` → new transcode endpoint (ffmpeg-static) → ProRes/DNxHR/MXF file + reveal-in-Explorer (the backend already does folder reveal). Honest labeling: these are *transcodes of a consumer master*, not 10-bit pixel-exact masters; direct server-side rendering is a later possibility. Queue jobs carry an optional `backendTranscode` stage so DEL-001's UI shows both stages.

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| DEL-001 | Render queue (multiple jobs) | MISSING | `services/renderer/scene-exporter.ts` events (insertion: new manager) | Design note above | browser-native | M | 1 |
| DEL-002 | AV1 / codec options on the client path | PARTIAL — H.264, VP9 today | `scene-exporter.ts` codec probing | Offer AV1 where `VideoEncoder` supports it (user's NVIDIA does); expose codec/bitrate overrides in an "Advanced" preset panel | browser-native | S | 1 |
| DEL-003 | Pro codecs: ProRes / DNxHR / MXF | MISSING | `backend/long-to-short/` (insertion: transcode module) | Design note above | backend-ffmpeg | L | 2 |
| DEL-004 | Render presets (social + custom) | HAVE — 7 platform presets | `apps/web/src/export/presets.ts` | Keep; add user-defined presets persisted in storage | browser-native | S | 1 |
| DEL-005 | In/out range render | MISSING — whole-scene(s) only today | scene range selection; `export/index.ts` scene targets | Timeline in/out points (pairs with EDIT-005 markers) feeding exporter start/end ticks | browser-native | S | 3 |
| DEL-006 | Burn-in captions vs sidecar files | PARTIAL — sidecar SRT/ASS export HAVE (`subtitles/`) | depends EDIT-012 (caption rendering) | Burn-in = render captions through the text-node path during export; toggle per job | browser-native | M | 3 |
| DEL-007 | Audio-only export (wav/mp3/aac) | MISSING | mediabunny `Output` audio sources | Audio-only job type through the offline audio render (FAIR export-parity work feeds this) | browser-native | S–M | 3 |
| DEL-008 | Quick export (from any page) | PARTIAL — export popover exists in the header | `components/editor/export-button.tsx`, pages shell | Keep header quick-export on every page; full control lives in Deliver; retire the bespoke gradient per `21` §5 | browser-native | S | 1 |
| DEL-009 | Render in place / bake subclip | MISSING | `media/clip-extraction.ts` (logical subclips exist) | Backend re-encode of a clip's range → new media asset replacing the element source | backend-ffmpeg | M | 4 |
| DEL-010 | Background render while editing | MISSING | worker/OffscreenCanvas investigation (risk R8) | Explore exporter-in-worker with OffscreenCanvas + its own wgpu context; until proven, queue runs when idle/foreground | browser-native | M–L (spike first) | 4 |
| DEL-011 | Direct upload (TikTok/YouTube/Instagram APIs) | OUT pending product decision — local-first product, OAuth/API review burden; current scope ends at "export + AI copy handoff" | `apps/web/src/socials/` (AI copy exists) | — | — | — | — |
| DEL-012 | Remote render (second machine) | OUT — single-machine product; the launcher could orchestrate a LAN render node later, revisit post-P5 | — | — | — | — | — |

## Rollup

- Rows: 12 → HAVE 1 · PARTIAL 3 · MISSING 6 · OUT 2
- Phase 1 flagship: **DEL-001 render queue** + DEL-002/DEL-004/DEL-008 small wins — the Clip Farmer persona's #1 unblock (queue up all shorts, walk away).
- The backend transcode module (DEL-003) is the first *new* backend surface the roadmap adds; keep its API job-shaped like the existing boss endpoints.
