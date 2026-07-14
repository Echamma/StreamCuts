# 14 — Feature Map: Color Page

**Resolve's Color page** is a grading environment: primary corrections (wheels/curves), secondaries (qualifiers + windows), LUTs, a node graph per clip, scopes, and a gallery of stills/versions.

**StreamCuts today: color grading is entirely absent** — the biggest single gap vs Resolve. There are no brightness/contrast/saturation controls, no curves, no LUTs, no scopes anywhere in the param registry or effect definitions. What *does* exist is the hosting infrastructure: a multi-pass GPU effect registry with exactly one effect ([baseline §7](./01-architecture-baseline.md#7-rendering-pipeline-preview--export)), 17 blend modes, a mature mask system ([§13](./01-architecture-baseline.md#13-masks--saliency)), keyframable effect params, and a bezier curve editor UI ([§6](./01-architecture-baseline.md#6-keyframes--curve-editor--mature-the-biggest-reusable-asset)).

## Design note: where grades live (COL-001)

Grades are **effect nodes on the existing effects path** — no new rendering concept:

- **Per-clip grade**: an ordered list of color `Effect`s in the element's existing `effects?: Effect[]` array (`opencut-classic/apps/web/src/timeline/types.ts`), rendered by the existing `resolveEffectPasses` flow.
- **Scene/track-wide grade**: an `EffectElement` on an effect track (adjustment-layer style), rendered by `opencut-classic/apps/web/src/services/renderer/nodes/effect-layer-node.ts` — both already exist.
- **All color math is WGSL** in `opencut-classic/rust/crates/effects/src/shaders/` (Rust-first policy, risk R3), registered as `EffectDefinition`s in `opencut-classic/apps/web/src/effects/definitions/index.ts`.
- Working space: document the pipeline as sRGB/Rec.709 until COL-014 says otherwise; all shader math in linear-light where it matters (lift/gamma/gain defined on normalized 0–1 with standard Resolve-style semantics).
- Every grade param registers as keyframable (the effects param registry already supports this).

⚠ All rows below inherit the **rework-collision flag** (risk R2) — they extend the renderer's effect registry. Mitigation: everything here is *additive* (new definitions + shaders), which is the agreed-safe zone.

## Primary corrections

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| COL-001 | Grading pipeline (per-clip + adjustment-layer grades) | MISSING | `effects/definitions/index.ts`, `nodes/effect-layer-node.ts` | Design note above; ship as the substrate of COL-002 | rust-wgsl | (in COL-002) | 1 |
| COL-002 | Primary wheels: lift / gamma / gain / offset | MISSING | `rust/crates/effects/src/shaders/` (insertion) | One `color-wheels` EffectDefinition: 4×(RGB+master) params, WGSL ASC-CDL-style math; wheels UI on the Color page (`20` §4) with luma-band trackballs | rust-wgsl | L (M shader + M UI) | 1 |
| COL-003 | Log wheels (shadow/mid/highlight ranges) | MISSING | same shader family as COL-002 | Range-weighted variant of COL-002 with adjustable low/high pivots; UI toggle Primaries⇄Log | rust-wgsl | M | 3 |
| COL-004 | Contrast, pivot, saturation, temperature, tint, hue | MISSING | same shader family as COL-002 | Second pass in the `color-wheels` definition (contrast-around-pivot, sat in YCbCr, temp/tint as white-balance gains) | rust-wgsl | M | 1 |

## Curves

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| COL-005 | Custom curves (Y, R, G, B) | MISSING | graph editor components `timeline/components/graph-editor/` (UI reuse) | Curve evaluated CPU-side into a 1D LUT texture (256–1024 samples) per channel, sampled in WGSL; **reuse `bezier-graph.tsx` interaction components** for the curve UI | rust-wgsl (browser-native UI) | L | 2 |
| COL-006 | HSL curves (hue-vs-hue, hue-vs-sat, lum-vs-sat, sat-vs-sat) | MISSING | same as COL-005 | Same 1D-LUT technique keyed on hue/lum/sat input axes; one shader, curve-type uniform | rust-wgsl | M (after COL-005) | 3 |

## Secondaries

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| COL-007 | Qualifier (HSL keyer) with matte finesse | MISSING | `rust/crates/effects` (insertion); mask compositing exists in `rust/crates/compositor` | Fragment-shader HSL range key → matte; reuse mask feather/blur (JFA/SDF in `rust/crates/masks`) for softening; matte routes into the grade node's mask slot. Fragment-only — works on WebGL2 ([40 §2](./40-technical-feasibility.md#2-gpu-compute--readback--the-scopes-question)) | rust-wgsl | M | 3 |
| COL-010 | Power windows (shape-limited grades) | PARTIAL — masks are mature but not linked to grades | `masks/` (8 shapes + freeform + GPU feather) | Wire the existing mask system into color effects: a grade's effect instance gets an optional mask reference; render = matte × grade. Mostly plumbing + UI | rust-wgsl | S–M | 3 |
| COL-021 | Window tracking | MISSING | depends FUS-005 (point tracking) | Tracker writes keyframes onto the mask's transform params (keyframe infra exists) | rust-wgsl | S (after FUS-005) | 4 |

## LUTs & scopes

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| COL-008 | 3D LUTs (.cube import, per-grade apply, intensity) | MISSING | `rust/crates/effects` (insertion); OPFS for LUT storage | `.cube` parser in Rust, 3D texture upload (33³/65³), tetrahedral interpolation in WGSL, intensity mix. **Not WebGPU-gated** — WebGL2 has TEXTURE_3D ([40 §3](./40-technical-feasibility.md#3-3d-luts)). LUT browser panel on the Color page | rust-wgsl | M | 2 |
| COL-009 | Scopes: waveform, RGB parade, vectorscope, histogram | MISSING | `rust/crates/gpu` (insertion for readback tap / compute) | Dual path per [40 §2](./40-technical-feasibility.md#2-gpu-compute--readback--the-scopes-question): WGSL compute reductions when WebGPU adapter present; async ~480×270 CPU tap fallback otherwise. Waveform + histogram first (P1), parade + vectorscope after (P3). Scopes render on a fixed dark surface with the dedicated dataviz palette (`21` §4) | rust-wgsl | L | 1 (wf/hist), 3 (parade/vec) |

## Grade management

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| COL-011 | Node-graph grading (serial → parallel/layer) | MISSING | element `effects[]` is already an ordered stack | v1 = **serial node stack** UI over the ordered effect list (add/reorder/disable/label nodes) — this is Fusion-lite's sibling ([40 §6](./40-technical-feasibility.md#6-node-graph-compositing)). Parallel/layer mixing later (needs matte/blend combine pass) | rust-wgsl | M (serial), L (parallel/layer) | 3 / 5 |
| COL-012 | Gallery: stills, grade versions, copy grade | MISSING | `core/managers/snapshot-manager.ts` (versions precedent), OPFS thumbnails | Still = frame grab + serialized grade stack; apply-grade = paste onto target clip's effects; versions ride the existing named-version pattern | browser-native | M | 3 |
| COL-013 | Group grading (pre/post-group grades) | MISSING | depends EDIT-006 (persistent groups) | Group entity carries its own grade stack rendered before/after clip grades | rust-wgsl | M | 5 |
| COL-014 | Color management / ACES | MISSING | renderer working-space assumption (doc-only today) | v1 = document sRGB/Rec.709 pipeline explicitly; input transforms/ACES = OUT until pro-codec ingest exists | rust-wgsl | L | 5 (statement only in 2) |
| COL-020 | Split-screen grade compare (vs still / vs version) | MISSING | preview surface `apps/web/src/preview/` | Composite still texture + live output split in the compositor; pairs with COL-012 | rust-wgsl | S–M | 3 |

## Creative & heavy FX

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| COL-015 | Noise reduction (spatial / temporal) | MISSING | `rust/crates/effects` | Spatial (bilateral/NLM-lite) = L on WebGL2; temporal needs motion + history buffers — **WebGPU-gated**, expensive | rust-wgsl | L (spatial), XL (temporal) | 4 |
| COL-016 | Film grain, vignette, glow (Resolve FX equivalents) | MISSING | effects registry — same pattern as blur | One EffectDefinition + WGSL each; S per effect once COL-002 establishes the color-param conventions | rust-wgsl | S each | 3+ |
| COL-017 | HDR grading & delivery | OUT — no 10-bit in-browser encode path ([40 §1](./40-technical-feasibility.md#1-codecs--containers)) | — | — | — | — | — |
| COL-018 | Magic Mask (AI subject/person mattes) | OUT near-term — segmentation-model runtime is a research project; revisit with backend GPU models (see XC-009) | — | — | — | — | — |
| COL-019 | Color warper (hue-sat mesh) | OUT — specialized mesh tool; qualifier (COL-007) + HSL curves (COL-006) cover the practical workflows at far lower cost | — | — | — | — | — |

## Rollup

- Rows: 21 → HAVE 0 · PARTIAL 1 · MISSING 17 · OUT 3
- Phase 1 flagship: **COL-002 + COL-004 wheels/adjustments + COL-009 waveform/histogram** — after which "grade a clip in StreamCuts" is a true sentence for the first time.
- Everything is additive to the effects registry; no timeline-model dependency except COL-013 (groups).
