# 15 — Feature Map: Fairlight (Audio) Page

**Resolve's Fairlight page** is a DAW inside the editor: a mixer with channel strips, buses, per-track EQ/dynamics, metering and loudness, automation, and recording.

**StreamCuts today: near-greenfield.** The Web Audio engine exists ([baseline §10](./01-architecture-baseline.md#10-audio)): `AudioContext` + master gain + per-clip scheduling in `opencut-classic/apps/web/src/core/managers/audio-manager.ts`, keyframable per-clip dB volume with an on-clip automation line, mute, source-audio separation, silence removal. There is **no** pan, no fades, no mixer, no buses, no meters, no EQ, no dynamics. An `audio-mixer` tab key already exists in the assets panel (`components/editor/panels/assets/assets-panel-store.tsx`) with no real mixer behind it — the Audio page promotes it to a first-class surface (`20` §4).

## Design note: the mixer graph (FAIR-001, FAIR-006)

Extend `audio-manager.ts` from *clips → master* to *clips → track strip → (bus) → master*:

```
clip source → clip gain (existing, keyframed)
  → track strip: [EQ biquads] → [dynamics] → pan (StereoPannerNode) → track gain
    → bus gain(s)
      → master: [limiter] → master gain → destination + metering worklet
```

- Track/bus/master become explicit graph nodes owned by the manager; the timeline's `AudioTrack[]` gains mixer state (gain, pan, mute, solo, bus routing) stored on the track — a storage migration.
- **Export parity is half the work** ([40 §4](./40-technical-feasibility.md#4-audio)): every audible feature must also run in the offline export path (`OfflineAudioContext` render or equivalent sample math feeding the mediabunny muxer). Each row below prices that in.
- Rust-first note (risk R3): Web Audio nodes are inherently browser-side; the ratified boundary keeps *graph orchestration* in TS while any custom DSP (worklet processors) may compile from Rust to wasm later.

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
<!-- 2026-07-14 audit: FAIR-001 is more built than "greenfield" implied — a per-track + per-element volume(dB)/mute mixer already ships in components/editor/panels/assets/views/audio-mixer.tsx, driven by resolveEffectiveAudioGain in timeline/audio-state.ts. Track SOLO added 2026-07-14 (timeline/audio-solo.ts routes playback + export gates through one helper; ToggleTrackSoloCommand; S button in the mixer). Genuine remaining gaps: pan (FAIR-002), meters (FAIR-007). -->
| FAIR-001 | Mixer with channel strips (gain/mute/solo per track + master) | MISSING | `core/managers/audio-manager.ts` (insertion); dormant `audio-mixer` tab | Design note above; mixer UI = the Audio page's primary bottom/right surface with vertical strips | browser-native | L | 1 |
| FAIR-002 | Pan (clip + track, automatable) | MISSING | same | `StereoPannerNode` per strip; pan param registered keyframable | browser-native | S | 1 |
| FAIR-003 | Clip fade handles & audio crossfades | MISSING | element trim handles in `timeline/controllers/`; visual transitions exist but no gain envelopes | Fade-in/out handles on audio (and video-with-audio) clips → equal-power gain ramps; crossfade = overlapping fades; **must render identically in export** | browser-native | M | 2 |
| FAIR-004 | Track EQ (4–6 band parametric) | MISSING | strip insert slot (design note) | `BiquadFilterNode` chain per strip; EQ curve UI (reuse curve-drawing patterns from the graph editor) | browser-native | M | 2 |
| FAIR-005 | Dynamics: compressor / gate / limiter | MISSING | strip insert slot | `DynamicsCompressorNode` v1 (compressor + master limiter); gate/expander as AudioWorklet DSP later | browser-native | M | 3 |
| FAIR-006 | Buses & submixes | MISSING | design note | v1 = fixed buses (Dialog/Music/SFX) + master; routing picker per track; bus strips in the mixer | browser-native | L | 3 |
| FAIR-007 | Meters (peak/RMS per strip) | MISSING | metering worklet (new `apps/web/src/audio/worklets/`) | `AudioWorkletNode` per strip tap → batched levels → canvas meters; meter colors from the fixed dataviz palette (`21` §4) | browser-native | M | 1 |
| FAIR-008 | Loudness: EBU R128 LUFS (M/S/I) + true peak on master | MISSING | same worklet family as FAIR-007 | K-weighted gating per BS.1770 in a worklet; loudness readout on Deliver page too (DEL burn-in of target loudness = later) | browser-native | M | 3 |
| FAIR-009 | Automation lanes (pan/EQ/sends, beyond volume) | PARTIAL — volume is keyframable with an on-clip line | `timeline/components/audio-volume-line.tsx`, animation registry | Register pan/EQ-band/send params as keyframable; lane UI reuses the existing graph editor ([baseline §6](./01-architecture-baseline.md#6-keyframes--curve-editor--mature-the-biggest-reusable-asset)) | browser-native | M | 3 |
| FAIR-010 | Voice isolation / dialogue leveler (AI) | MISSING | `backend/long-to-short/python/` worker (insertion) | Backend job: RNNoise/DeepFilterNet-class denoise or demucs-class separation on the user's NVIDIA GPU; returns processed audio as new media | backend-ffmpeg (native-new model runtime) | L | 4 |
| FAIR-011 | Recording / ADR | OUT near-term — `getUserMedia` is feasible but outside the four-pillar core; revisit after buses land | — | — | — | — | — |
| FAIR-012 | Surround / spatial audio | OUT — product is stereo; WebCodecs/mediabunny mastering path is stereo-first | — | — | — | — | — |
| FAIR-013 | VST/AU plugins & FairlightFX | infeasible-web — native plugin ABIs can't load in a browser ([40 §4](./40-technical-feasibility.md#4-audio)). Substitute: built-in **worklet effects rack** (chorus/delay/reverb/de-esser) | strip insert slots | Worklet-based rack, effects written once against an internal insert API | browser-native | M (rack) | 5 |
| FAIR-014 | Sound library | HAVE | `apps/web/src/sounds/` (searchable library, Freesound-backed), saved sounds in storage | Keep; relocates to Media/Audio pages in the shell (`20` §4) | browser-native | — | — |

## Rollup

- Rows: 14 → HAVE 1 · PARTIAL 1 · MISSING 9 · OUT 2 · infeasible 1
- Phase 1 flagship: **FAIR-001 + FAIR-002 + FAIR-007** — a real mixer with gain/pan/mute/solo and live meters, promoting the dormant `audio-mixer` tab into the Audio page.
- The recurring hidden cost is **export parity** — call it out in every implementation PR.
