# 10 — Feature Map: Media Page

**Resolve's Media page** is ingest and organization: media pool with bins, metadata, proxy/optimized media, sync, scene detection, archive.

**StreamCuts today**: solid import + storage ([baseline §14](./01-architecture-baseline.md#14-storage-autosave--recovery--mature)) — WebCodecs-decodable formats into OPFS, thumbnails/waveforms, logical subclips, folder organization in the media panel. **No re-encoded proxies, no metadata layer, no sync/scene tools.** StreamCuts' unique strength — the AI ingest pipelines (boss / long-to-short / summarize) — logically belongs to this page in the shell (`20` §4).

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| MED-001 | Media pool with bins/folders | PARTIAL — media tab with folders, view modes, sort | `components/editor/panels/assets/` (folders state in `assets-panel-store.tsx`) | Keep; grows into the Media page's full-width pool with list/grid + filter bar | browser-native | S–M | 0 (shell move) |
| MED-002 | Smart bins (rule-based) | MISSING | depends MED-003 | Saved queries over metadata (type, resolution, fps, tags, transcript-contains) | browser-native | M | 4 |
| MED-003 | Metadata editor & clip attributes | MISSING | `services/storage/` media metadata records (insertion) | Per-asset metadata (tags, notes, rating, custom fields) + inspector UI; feeds MED-002 and search | browser-native | M | 3 |
| MED-004 | Media storage browser (drive browsing) | MISSING | File System Access API | Persisted directory handles ("watched folders") listed alongside the pool; import stays copy-into-OPFS | browser-native | M | 4 |
| MED-005 | Proxy media generation | MISSING — **flagship**; unblocks multicam ([40 §7](./40-technical-feasibility.md#7-decode-pressure--multicam)) | `backend/long-to-short/` (insertion: proxy module); `services/video-cache/` consumes | Backend ffmpeg renders ~540p H.264 proxies per asset (job-shaped like boss endpoints); video cache prefers proxy sinks during editing, full-res on export; per-project storage budget view ([40 §8](./40-technical-feasibility.md#8-storage)) | backend-ffmpeg | L | 2 |
| MED-006 | Optimized media (edit-friendly transcode of hard codecs) | MISSING | same module as MED-005 | Variant of the proxy pipeline at source resolution for codecs the browser decodes poorly | backend-ffmpeg | M (after MED-005) | 4 |
| MED-007 | Audio sync (waveform cross-correlation) | MISSING | waveform summaries exist (`media/waveform-summary.ts`) | Cross-correlate waveform envelopes (Rust or backend); prerequisite for multicam (EDIT-014) | rust-wgsl (backend-ffmpeg alt) | M | 4 |
| MED-008 | Scene cut detection | MISSING | `backend/long-to-short/` ffmpeg `scdet`/`select` | Backend job returns cut list → markers (EDIT-005) or auto-split; long-form ingest booster | backend-ffmpeg | M | 4 |
| MED-009 | Relink / archive / media management | MISSING — OPFS copies make projects self-contained by default | `services/storage/opfs-adapter.ts` | Design note: export project archive (project JSON + OPFS media) to a folder/zip; import re-links by content hash. Missing-media placeholder state | browser-native | M | 5 |
| MED-012 | Stills export from media/viewer | MISSING | pointer to COL-012 gallery | Frame-grab action → PNG (also feeds grade stills) | browser-native | S | 3 |
| MED-013 | AI ingest: long-to-short, boss chapters/shorts, summarize | HAVE — StreamCuts-unique (no Resolve equivalent) | `components/editor/panels/boss/`, `long-to-short/`, backend pipelines | Keep; relocate surfaces to the Media page (`20` §4); dedupe legacy `/api/boss/*` routes eventually | backend-ffmpeg | — | — |
| MED-010 | Capture (deck/tape ingest) | OUT — no deck hardware market for this product | — | — | — | — | — |
| MED-011 | Clone tool (checksummed card offload) | OUT — DIT workflow outside product scope | — | — | — | — | — |

## Rollup

- Rows: 13 → HAVE 1 · PARTIAL 1 · MISSING 9 · OUT 2
- The pivotal row is **MED-005 proxies** — it unlocks multicam (EDIT-014), optimized media (MED-006), and smoother heavy-timeline editing, and it's the natural first expansion of the backend beyond AI clipping.
