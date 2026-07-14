# 40 — Technical Feasibility Appendix

Web-platform limits that decide which feasibility class a feature lands in. Inventory rows cite these sections; each section ends with the feature IDs it constrains.

## 1. Codecs & containers

**In-browser (WebCodecs + mediabunny)**: encode H.264 (hardware-dependent profiles), VP9, AV1 (where hardware/browser support exists); decode whatever the local Chromium build + GPU expose. **Not available in-browser**: ProRes, DNxHR, MXF wrapping, 10-bit/HDR mastering, interlaced formats.

Consequence: the current client export path (`opencut-classic/apps/web/src/services/renderer/scene-exporter.ts`) stays the *creative* export; **professional deliverables are a `backend-ffmpeg` job** — export a high-bitrate H.264/VP9 master client-side, then hand it to `backend/long-to-short/` for transcode (ProRes/DNxHR/MXF), or render directly server-side for pixel-exact masters later. HDR delivery is OUT near-term (no 10-bit client encode).

*Constrains: DEL-002…DEL-005, COL-017 (HDR).*

## 2. GPU compute & readback — the scopes question

**The compositor runs wgpu on the WebGL2 backend, and WebGL2 has no compute shaders.** GPU histogram/waveform reduction passes are therefore unavailable unless the WebGPU adapter is enabled.

Recommended dual path:

1. **Primary — WebGPU adapter.** The target user runs Chromium on Windows/NVIDIA, where WebGPU is available. Gate scopes (waveform/parade/vectorscope/histogram) and temporal noise reduction on a WebGPU capability check; implement reductions as WGSL compute in `opencut-classic/rust/crates/gpu`.
2. **Fallback — CPU tap.** A downscaled readback (~480×270 `readPixels` per preview frame, ≈0.5 MB) feeds CPU-side scope computation. That sustains 30 fps scopes at reduced precision. Readback stalls the GL pipeline, so the tap must be async (fence/`getBufferSubData`-style) and skippable under load. Natural seam: `opencut-classic/rust/crates/gpu` alongside the blit shaders.

**Important non-gate**: HSL qualifiers, color wheels, curves, LUTs are all *fragment-shader* work — they run fine on WebGL2 and are **not** WebGPU-gated.

*Constrains: COL-009 (scopes), COL-015 (temporal NR). Risk R5.*

## 3. 3D LUTs

WebGL2/GLES3 supports `TEXTURE_3D` natively and wgpu exposes it on the GL backend. Plan: parse `.cube` in Rust (new small module in `opencut-classic/rust/crates/effects`), upload as a 3D texture (33³ default, 65³ supported), apply with tetrahedral interpolation in WGSL. **LUTs are not WebGPU-gated — do not over-scope this.** Effort M.

*Constrains: COL-008.*

## 4. Audio

Web Audio API covers the Fairlight-lite set natively:

- **Mixer graph**: per-track `GainNode` + `StereoPannerNode`, buses as intermediate gain nodes, master chain — extends `opencut-classic/apps/web/src/core/managers/audio-manager.ts` directly.
- **EQ**: `BiquadFilterNode` chains (4–6 bands). **Dynamics**: `DynamicsCompressorNode` first; custom AudioWorklet DSP for gate/limiter later.
- **Meters & loudness**: `AudioWorkletNode` computing peak/RMS/true-peak per track and EBU R128 LUFS (momentary/short-term/integrated) on the master. Worklets run off-main-thread; UI reads a SharedArrayBuffer or message-batched levels.
- **Export parity caveat**: preview audio runs through the live graph, but export renders audio offline through the mediabunny path — every audible feature (fades, pan, EQ, bus gains) needs an **offline render equivalent** (an `OfflineAudioContext` pass, or reimplemented sample math) or exports won't match preview. Budget this into every FAIR estimate.
- **VST/AU hosting: infeasible-web.** Native plugin ABIs cannot load in a browser. The substitute is a worklet-based "effects rack" with built-in DSP.
- Recording via `getUserMedia` is feasible (OUT of the four-pillar core for now).

*Constrains: FAIR-001…FAIR-012.*

## 5. Variable retime math

Represent time remap as a **piecewise-monotonic curve mapping timeline ticks → source ticks**, keyframed on the existing animation system, evaluated in integer `MediaTime` (120,000 ticks/s) — exact, no float drift. The current `RetimeConfig { rate }` becomes the 2-point special case. Interactions to spec: pitch-preserve (soundtouchjs) needs per-segment rates; frame sampling picks nearest source frame (blend/optical-flow interpolation is a later `backend-ffmpeg`/`native-new` option — RIFE-class models on the user's NVIDIA GPU via the backend Python worker).

*Constrains: EDIT-009, FUS-012.*

## 6. Node-graph compositing

The renderer already **is** a node tree (`scene-builder.ts` → 12 node types → `resolve.ts`), just not user-facing. A user-visible graph means: serialize a constrained subgraph into project data (storage migration), a graph UI (the bezier graph editor components prove the team can ship canvas editors), and cycle/type discipline. That's why the roadmap scopes **Fusion-lite = ordered effect/layer stack first (L)**, full patch-graph later (XXL). The stack maps 1:1 onto existing `effects?: Effect[]` arrays and `effect-layer-node.ts`.

*Constrains: FUS-001, COL-011.*

## 7. Decode pressure & multicam

The video cache holds **≤ 6 decoder sinks** (LRU, `services/video-cache/service.ts`), and WebCodecs decoders are a hardware-limited resource. A 4-angle multicam + program view + scrub-ahead already saturates that. Multicam therefore depends on **proxy media** (MED-005): low-res proxies decode cheaply and switch to full-res on export. Raising the LRU ceiling is not a fix — decoder handles and VRAM are the real limits.

*Constrains: EDIT-014, MED-005.*

## 8. Storage

OPFS quota is browser-managed (typically GBs; feature-detected with fallback already in `services/storage/`). Proxies and stills multiply storage: budget a per-project usage view and eviction story (MED-005/COL-012 design notes). Schema changes ride the existing 34-migration lineage — the R1 track-model migration is by far the largest and must ship with snapshot-based rollback (the snapshot manager already exists).

*Constrains: MED-005, COL-012, R1 migration.*

## 9. Browser matrix

The product targets **local Chromium on Windows** (the launcher opens the default browser; docs should recommend Chrome/Edge). WebGPU, WebCodecs H.264/AV1, OPFS, and AudioWorklet are all present there. Safari/Firefox gaps (WebGPU maturity, codec support, OPFS quirks) are documented as non-blocking: features degrade (scopes fall back to CPU tap, AV1 encode may be absent) but the editor stays usable.

*Constrains: nothing hard — informs R5 minimum-experience statement.*
