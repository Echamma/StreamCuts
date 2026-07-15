# 13 — Feature Map: Fusion Page

**Resolve's Fusion page** is a full node-based compositor: patch-graph compositing, keying, roto, tracking, particles, 3D. **This file is deliberately honest: full Fusion parity is `OUT`/XXL** — it is a decade of specialized software. What the roadmap pursues instead is **"Fusion-lite"**: the compositing capabilities creators actually reach for (key, roto, track, motion titles, an inspectable effect stack), built on infrastructure StreamCuts already has — the renderer *is* a node tree internally ([40 §6](./40-technical-feasibility.md#6-node-graph-compositing)), masks are mature, keyframes are mature.

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| FUS-001 | Node-based compositing (user-facing) | PARTIAL — node tree exists internally (`services/renderer/scene-builder.ts` → 12 node types), not user-visible | renderer + `effects[]` stacks | **Fusion-lite v1 = ordered, inspectable effect/layer stack per element** (same surface as COL-011's serial nodes). Full patch-graph UI = XXL, re-triaged at P5 ([30 §5](./30-phased-plan.md)) | rust-wgsl ⚠R2 | L (stack) / XXL (graph) | 4 / 5-triage |
| FUS-002 | Chroma / luma keying | MISSING | `rust/crates/effects` (insertion); matte plumbing shared with COL-007 | WGSL chroma key (YCbCr distance + spill suppression) + luma key; matte feeds mask slot (feather via `rust/crates/masks`) | rust-wgsl | M–L | 4 |
| FUS-003 | Mattes & rotoscoping | PARTIAL — freeform bezier masks + GPU feather exist; roto = animating them | `masks/freeform/`, keyframe system | Make mask control points keyframable over time (registry entries + graph-editor lanes); onion-skin overlay UI | browser-native (masks exist) | M | 4 |
| FUS-005 | Point / planar tracking | MISSING | `rust/crates/` (new `tracking` crate) | v1 point tracker (template matching / KLT-style) writing keyframes onto transform or mask params; feeds COL-021 window tracking. Planar later | rust-wgsl | L | 4 |
| FUS-008 | Text+ motion titles | PARTIAL — static text mature; word-by-word caption animation schema is a foundation | `text/`, `subtitles/animation/`, EDIT-017 | Motion-title presets = text + baked keyframe/animation bundles; editor for per-character/word animation after EDIT-012 ships | browser-native | L | 5 |
| FUS-010 | Templates / macros | MISSING | effect stacks must serialize first (FUS-001) | Save/load named effect-stack + title presets; share as JSON | browser-native | M | 5 |
| FUS-012 | Optical-flow tools (retime interpolation, speed warp) | MISSING — pointer to EDIT-010 note | `backend/long-to-short/python/` (RIFE-class on NVIDIA GPU) | Frame-interpolated retime as a backend render option; see [40 §5](./40-technical-feasibility.md#5-variable-retime-math) | backend-ffmpeg (native-new) | L | 5 |
| FUS-004 | Camera / 3D tracking | OUT — research-grade; no 3D scene to feed | — | — | — | — | — |
| FUS-006 | Particles | OUT — motion-graphics engine outside product scope near-term | — | — | — | — | — |
| FUS-007 | 3D scene & objects | OUT — same reason as FUS-006 | — | — | — | — | — |
| FUS-009 | Expressions / comp scripting | OUT near-term — revisit alongside XC-004 scripting; the param/keyframe registry would be the binding surface | — | — | — | — | — |
| FUS-011 | Paint | OUT — niche; masks + stickers cover most creator cases | — | — | — | — | — |

## Rollup

- Rows: 12 → HAVE 0 · PARTIAL 3 · MISSING 4 · OUT 5
- The honest sequence: ship keying + roto + tracking (P4) on existing mask/effect infra, expose the stack (FUS-001 v1), and only then judge whether a patch-graph UI earns its XXL cost.
