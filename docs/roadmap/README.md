# StreamCuts Roadmap — DaVinci Resolve Feature Integration & UX Overhaul

## What this is / is not

**Is**: a comprehensive, codebase-anchored roadmap mapping every DaVinci Resolve feature cluster (~108 items across 7 pages + cross-cutting) onto this monorepo, with per-feature status, proposed approach, feasibility class, and effort estimate — plus the UX overhaul design (pages shell, design tokens, research plan) that carries it.

**Is not**: shipped code (this document set changes no behavior), a parity or compatibility claim (DaVinci Resolve is Blackmagic Design's trademark and our *reference model*, not a target we advertise against — risk R9), or a promise — estimates carry the uncertainty rules in [00](./00-method-and-legend.md).

## Executive summary

StreamCuts already has an unusually strong core for a browser editor: a frame-accurate integer time model, a Rust/wgpu GPU compositor with 17 blend modes and mature masks, WebCodecs preview+export through one shared renderer, a bezier keyframe editor, crash-safe storage with 34 schema migrations, rebindable shortcuts, and a local AI backend (GPU Whisper + Gemini clip planning) Resolve has no equivalent for.

The four gaps that define this roadmap: **color grading does not exist**, **audio has no mixer/fades/meters**, **the edit toolset lacks the pro trim/organization layer** (roll/slip/slide, markers, groups, variable speed), and **delivery is a single foreground job**. Two finished features are lying dormant and only need wiring: word-by-word caption animation and saliency auto-reframe — they headline Phase 1.

The UX bet: replace the crowded 14-tab single workspace with **five DaVinci-style pages** (Media · Edit · Color · Audio · Deliver) built as layout presets over the existing panel system, and consolidate the visual system into real design tokens while keeping the sky-blue brand.

The structural risk to respect: the timeline's **single-main-track model** (R1) must migrate to uniform video tracks *before* color and audio attach per-track data — that anchors Phase 2.

## How to read

Start with [00-method-and-legend.md](./00-method-and-legend.md) (status/feasibility/effort vocabulary, feature-ID scheme) and [01-architecture-baseline.md](./01-architecture-baseline.md) (what exists, with paths). Every feature row cites its anchor in the baseline; every estimate uses the `00` scale.

## Document map

| Doc | Contents |
|---|---|
| [00-method-and-legend.md](./00-method-and-legend.md) | Taxonomies, ID scheme, the ~108-item coverage checklist, maintenance protocol |
| [01-architecture-baseline.md](./01-architecture-baseline.md) | Current-state subsystem map (18 sections, verified paths) |
| [10-feature-map-media.md](./10-feature-map-media.md) | Media page: pool, proxies (flagship), sync, scene detection |
| [11-feature-map-cut.md](./11-feature-map-cut.md) | Cut page: folded into Edit/Media (verdict + salvaged tools) |
| [12-feature-map-edit.md](./12-feature-map-edit.md) | Edit page: trims, markers, groups, retime, multicam, captions |
| [13-feature-map-fusion.md](./13-feature-map-fusion.md) | Fusion: honest scoping — Fusion-lite (key/roto/track), graph deferred |
| [14-feature-map-color.md](./14-feature-map-color.md) | Color page: wheels, curves, qualifier, windows, LUTs, scopes, gallery |
| [15-feature-map-fairlight.md](./15-feature-map-fairlight.md) | Audio: mixer, fades, EQ, dynamics, buses, meters, loudness |
| [16-feature-map-deliver.md](./16-feature-map-deliver.md) | Deliver: render queue (flagship), pro codecs via backend, burn-ins |
| [17-feature-map-cross-cutting.md](./17-feature-map-cross-cutting.md) | Interchange, scripting, workspace, the AI cluster |
| [20-ux-pages-shell.md](./20-ux-pages-shell.md) | Five-page workspace architecture + 14-tab redistribution |
| [21-design-tokens-spec.md](./21-design-tokens-spec.md) | Token system, surfaces, Button reconciliation, cleanup register |
| [22-ux-research.md](./22-ux-research.md) | Personas (Eli/Mara/Kai), journeys J1/J2, usability gate |
| [30-phased-plan.md](./30-phased-plan.md) | Phases 0–5, dependency graph, effort roll-up, re-plan triggers |
| [40-technical-feasibility.md](./40-technical-feasibility.md) | Web-platform limits (codecs, WebGPU/scopes, LUTs, audio, retime) |
| [41-risks-and-open-questions.md](./41-risks-and-open-questions.md) | R1–R10 + open questions |

## Coverage matrix

Feature rows per DaVinci page (statuses per [00](./00-method-and-legend.md)):

| Area | Rows | HAVE | PARTIAL | MISSING | OUT | infeasible-web |
|---|---|---|---|---|---|---|
| Media (MED) | 13 | 1 | 1 | 9 | 2 | — |
| Cut (CUT) | 6 | 1 | 1 | 2 | 2 | — |
| Edit (EDIT) | 27 | 5 | 12 | 10 | — | — |
| Fusion (FUS) | 12 | — | 3 | 4 | 5 | — |
| Color (COL) | 21 | — | 1 | 17 | 3 | — |
| Fairlight (FAIR) | 14 | 1 | 1 | 9 | 2 | 1 |
| Deliver (DEL) | 12 | 1 | 3 | 6 | 2 | — |
| Cross-cutting (XC) | 14 | 3 | 2 | 5 | 4 | — |
| **Total** | **119** | **12** | **24** | **62** | **20** | **1** |

Plus 19 `UX-` rows (shell, tokens, research) in `20`–`22`, all Phase 0.

## Phase strip

| Phase | Theme | Headlines |
|---|---|---|
| 0 | Shell, tokens, debt paydown | Pages shell (Edit unchanged), token system, Button/toast/bug cleanup, usability gate |
| 1 | Four-pillar MVPs | Color wheels + waveform · mixer v1 + meters · roll/slip/slide + markers + **wire captions & auto-reframe** · render queue |
| 2 | Timeline foundations | **R1 uniform-track migration** · curves + LUTs · fades + EQ · pro codecs + proxies |
| 3 | Grading & mixing depth | Qualifier, windows, full scopes, node stack, gallery · buses, dynamics, loudness, automation · compounds, adjustment clips |
| 4 | Motion, interchange, intelligence | Fusion-lite (key/roto/track) · speed ramps, multicam · OTIO, text-based editing |
| 5 | Ecosystem & stretch | Scripting API, dual-monitor, group grading, effects rack · re-triage of XL/XXL |
