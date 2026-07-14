# 17 — Feature Map: Cross-Cutting

Everything that isn't one Resolve page: project infrastructure, collaboration, interchange, scripting, workspace, and the AI cluster (Resolve's "Neural Engine" ↔ StreamCuts' actual differentiator).

## Infrastructure & workspace

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| XC-001 | Project database / library | PARTIAL — per-browser IndexedDB/OPFS projects, named versions, crash recovery | `services/storage/service.ts`, `snapshot-manager.ts` | Keep local-first. Shared/central DB is OUT (risk R6) — the inactive Postgres scaffold stays inactive | browser-native | — | — |
| XC-002 | Collaboration (multi-user bins/timeline) | OUT — local-first product; would require auth+sync+conflict model and a product repositioning (risk R6) | — | — | — | — | — |
| XC-005 | Keyboard customization | HAVE — rebindable actions with conflict detection, persisted, migrated | `apps/web/src/actions/` | Keep; add page-switch actions (`20` §2) and per-page action contexts; S polish | browser-native | S | 0 |
| XC-006 | Control surfaces / grading panels | OUT — no WebHID device ecosystem worth the investment for this product | — | — | — | — | — |
| XC-007 | Dual-monitor workspace (scopes/viewer on 2nd screen) | MISSING | pages shell (`20`) | Second window via `window.open` + BroadcastChannel state mirror; scopes/preview first | browser-native | M | 5 |
| XC-008 | Localization | OUT near-term — single-locale product; revisit if distribution widens | — | — | — | — | — |

## Interchange & automation

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| XC-003 | Timeline interchange: OTIO (EDL/FCXML later; AAF out) | MISSING | `rust/crates/time` adjacency (new `interchange` module); timeline types | **OTIO-first**: import/export OpenTimelineIO JSON mapped onto scenes/tracks/elements — exact on the integer tick grid; EDL/FCXML as follow-ups; AAF = OUT (format complexity ≫ value here) | rust-wgsl (parser) + browser-native | M–L | 4 |
| XC-004 | Scripting & external API | MISSING | command pattern + actions registry are the natural surface ([baseline §5, §15](./01-architecture-baseline.md#5-undo--commands)) | Two layers: (1) in-app command console executing registered actions/commands; (2) local HTTP automation endpoint (backend or launcher) driving the editor via a message bridge — enables watch-folder → ingest → export pipelines (persona P3) | browser-native + native-new | M–L | 5 |

## The AI cluster

Resolve ships AI as "Neural Engine" features. StreamCuts already owns several — this is the differentiator to protect while borrowing Resolve's ergonomics.

| ID | Resolve feature ↔ StreamCuts | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| XC-009 | Transcription (audio → text) | HAVE ×2 — **two stacks** (risk R7): in-browser Whisper and backend faster-whisper (GPU) | `apps/web/src/transcription/`, `backend/long-to-short/python/transcribe.py` | Consolidate: backend is primary when the launcher runs (faster, GPU, large models); browser stack is the no-backend fallback. One `TranscriptionProvider` interface, decided before XC-010 | browser-native + backend-ffmpeg | M | 4 |
| XC-010 | Text-based editing (edit video by editing transcript) | MISSING | transcript data exists per media; silence removal precedent (`commands/timeline/element/remove-silence.ts`) | Transcript view where deleting words/sentences ripple-cuts the timeline; builds directly on XC-009 word timestamps | browser-native | L | 4 |
| XC-011 | Smart reframe | PARTIAL — pointer to **EDIT-016** (saliency crate done, wiring pending) | `rust/crates/saliency` | See EDIT-016 (Phase 1 quick win) | rust-wgsl | S–M | 1 |
| XC-012 | Scene detection | MISSING — pointer to **MED-008** | backend ffmpeg | See MED-008 | backend-ffmpeg | M | 4 |
| XC-013 | Magic Mask / Relight / Super Scale / Speed Warp (model-heavy) | OUT near-term — each needs a curated model runtime on the backend GPU (segmentation / relighting / super-res / optical flow). Revisit as a "backend model runtime" epic after P5; the Python worker pattern is the insertion point | `backend/long-to-short/python/` | — | — | — | — |
| XC-014 | AI clip planning: long-to-short, chapters, shorts, summaries, social copy | HAVE — **StreamCuts-unique, no Resolve equivalent** | boss/summarize/long-to-short pipelines + Gemini | Keep and feature it on the Media page; fix the two divergent default Gemini model strings ([baseline §16](./01-architecture-baseline.md#16-backend-backendlong-to-short)) | backend-ffmpeg | S (cleanup) | 0 |

## Rollup

- Rows: 14 → HAVE 3 · PARTIAL 2 · MISSING 5 · OUT 4
- Decisions this file forces: R6 (collab stays out), R7 (transcription consolidation before text-based editing).
- XC-010 text-based editing is the highest-leverage MISSING item here — it converts the existing transcription asset into an editing paradigm Resolve charges Studio money for.
