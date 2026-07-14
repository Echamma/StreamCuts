# 00 — Method & Legend

This file defines the vocabulary every other roadmap document uses. Nothing in `10`–`41` may invent a new status, feasibility class, or effort value: if a concept is missing here, add it here first.

## Sources & state-of-tree reference

- **DaVinci Resolve reference**: the public feature set of DaVinci Resolve 19/20 (Blackmagic Design feature pages and reference-manual table of contents) as of mid-2026. Resolve is the *reference model* for capability coverage — not a compatibility or parity target (see risk R9 in [41-risks-and-open-questions.md](./41-risks-and-open-questions.md)).
- **StreamCuts state**: verified against this repository at commit `ffd657556537dd3d36126d3944dc71daa2316e0a` (branch `claude/davinci-resolve-integration-731eaa`, 2026-07-13). Every `HAVE`/`PARTIAL` claim cites a real path that existed at this commit. If the tree moves, re-verify paths before relying on a row.

## Feature-ID scheme

Every inventory row carries a stable ID: a prefix + 3 digits (e.g. `COL-004`).

| Prefix | Domain | File |
|---|---|---|
| `MED-` | Media page | [10-feature-map-media.md](./10-feature-map-media.md) |
| `CUT-` | Cut page | [11-feature-map-cut.md](./11-feature-map-cut.md) |
| `EDIT-` | Edit page | [12-feature-map-edit.md](./12-feature-map-edit.md) |
| `FUS-` | Fusion page | [13-feature-map-fusion.md](./13-feature-map-fusion.md) |
| `COL-` | Color page | [14-feature-map-color.md](./14-feature-map-color.md) |
| `FAIR-` | Fairlight page | [15-feature-map-fairlight.md](./15-feature-map-fairlight.md) |
| `DEL-` | Deliver page | [16-feature-map-deliver.md](./16-feature-map-deliver.md) |
| `XC-` | Cross-cutting (collab, interchange, scripting, AI) | [17-feature-map-cross-cutting.md](./17-feature-map-cross-cutting.md) |
| `UX-` | Pages shell, tokens, research actions | [20-ux-pages-shell.md](./20-ux-pages-shell.md), [21-design-tokens-spec.md](./21-design-tokens-spec.md) |

Rules: IDs are never reused or renumbered. A feature that moves files keeps its ID (leave a pointer row behind). The phase plan ([30-phased-plan.md](./30-phased-plan.md)) and risk register reference features by ID only.

## Status taxonomy

| Status | Meaning | Obligation |
|---|---|---|
| `HAVE` | Exists and is usable today | Cite at least one real repo path |
| `PARTIAL` | Infrastructure or a subset exists | Cite the path *and* name what is missing |
| `MISSING` | Nothing exists | Cite the insertion point (which manager/registry/crate the work would extend) |
| `OUT` | Deliberately out of scope | State a one-line reason (no apology, no estimate) |

## Feasibility classes

Primary class is mandatory; a secondary class may follow in parentheses when work spans layers.

| Class | Meaning |
|---|---|
| `browser-native` | TypeScript + Web APIs inside `opencut-classic/apps/web` (Web Audio, WebCodecs, OPFS, workers/worklets) |
| `rust-wgsl` | New work in `opencut-classic/rust/crates/*` (Rust and/or WGSL shaders), surfaced through the `bridge` crate `#[export]` macro into the `opencut-wasm` package |
| `backend-ffmpeg` | Needs the local NestJS backend (`backend/long-to-short/`): ffmpeg-static transcode, faster-whisper, Gemini |
| `native-new` | Needs native capability neither layer has today (filesystem watchers, new backend service, launcher work in `launcher/src`) |
| `infeasible-web` | Not deliverable in this architecture even with the local backend; documented for honesty, never phased |

## Effort scale

Calibrated for **one senior developer with AI assistance**, working inside the repo's Rust-first policy (`opencut-classic/AGENTS.md`) — the wasm-bridge overhead is priced in.

| Effort | Range | Typical shape |
|---|---|---|
| `S` | < 1 dev-week | Isolated change on existing infra (e.g. registering one new WGSL effect in the existing registry) |
| `M` | 1–3 dev-weeks | New module inside existing patterns (a new panel, an effect family, a trim command) |
| `L` | 3–8 dev-weeks | New cross-layer subsystem: UI + core manager + renderer/Rust (e.g. color wheels + grade node + scopes v1) |
| `XL` | 8–16 dev-weeks | Architectural change (multi-main-track migration, user-facing node graph, full mixer/bus model) |
| `XXL` | 16+ dev-weeks | Research-grade (Fusion parity, real-time collaboration) |

Estimation rules:

1. Composite features list sub-items with their own `S`/`M` and roll up in the cluster header.
2. Any row touching `opencut-classic/apps/web/src/services/renderer/` or the export path carries a **⚠ rework-collision flag** (risk R2 — the README warns preview/effects/export are being reworked) and should be read with one notch of extra uncertainty.
3. `OUT` and `infeasible-web` rows get no estimate ("—").

## Row schema

All inventory tables use:

`ID | Resolve feature | Status | StreamCuts anchor (paths) | Proposed approach | Feasibility | Effort | Phase`

Clusters that require real design discussion (`L`/`XL`) additionally get a prose **Design notes** subsection below the table.

## DaVinci Resolve coverage checklist

The canonical flat list of Resolve feature clusters this roadmap must account for. **Verification rule: every item below must appear as at least one ID'd row in exactly one inventory file.** (Generated from the Resolve 19/20 public feature set; ~92 items.)

### Media page → `10`
1. Media pool & bins — MED
2. Smart bins / power bins — MED
3. Metadata editor & clip attributes — MED
4. Media storage browser (drive browsing) — MED
5. Proxy media generation — MED
6. Optimized media — MED
7. Audio sync (waveform / timecode) — MED
8. Scene cut detection — MED
9. Relink / archive / media management — MED
10. Capture (deck/tape) — MED
11. Clone tool (checksummed offload) — MED
12. Stills export from media — MED (folded into gallery COL row pointer)

### Cut page → `11`
13. Source tape mode — CUT
14. Fast review — CUT
15. Smart insert / append / place-on-top / close-up — CUT
16. Sync bin — CUT
17. Boring detector — CUT
18. Quick export from Cut — CUT (points at DEL)

### Edit page → `12`
19. Multi-track video timeline — EDIT
20. Trim modes: roll / slip / slide — EDIT
21. Ripple edit / ripple delete — EDIT
22. Dynamic trim / JKL — EDIT
23. Markers with notes, colors, durations — EDIT
24. Clip groups (persistent) — EDIT
25. Compound clips / nested timelines — EDIT
26. Take selector — EDIT
27. Constant speed change — EDIT
28. Speed ramps / variable retime — EDIT
29. Stabilization — EDIT
30. Keyframe animation + curve editor — EDIT
31. Video transitions library — EDIT
32. Titles & Text+ — EDIT
33. Subtitles / closed captions — EDIT
34. Multicam editing — EDIT
35. Adjustment clips — EDIT
36. Generators (solids, gradients, test patterns) — EDIT
37. Freeze frame — EDIT
38. Match frame / edit index — EDIT
39. Transform / position animation — EDIT
40. Auto-reframe — EDIT
41. Track locking & clip disable — EDIT
42. Linked audio/video clips — EDIT
43. Safe areas / guides — EDIT
44. Copy/paste attributes — EDIT

### Fusion page → `13`
45. Node-based compositing — FUS
46. Chroma / luma keying — FUS
47. Mattes & rotoscoping — FUS
48. Point / planar tracking — FUS
49. Camera / 3D tracking — FUS
50. Particles — FUS
51. 3D scene & objects — FUS
52. Expressions / scripting in comps — FUS
53. Text+ motion titles — FUS
54. Templates / macros / Fusion generators — FUS
55. Paint — FUS
56. Optical flow tools (Fusion-side) — FUS (points at EDIT retime)

### Color page → `14`
57. Primary wheels (lift/gamma/gain/offset) — COL
58. Log wheels — COL
59. Contrast / pivot / saturation / temp / tint — COL
60. Custom curves — COL
61. HSL curves (hue-vs-hue etc.) — COL
62. Qualifier (HSL keyer) — COL
63. Power windows — COL
64. Window tracking — COL
65. LUTs (.cube import, per-node apply) — COL
66. Scopes: waveform / parade / vectorscope / histogram — COL
67. Node graph grading (serial / parallel / layer) — COL
68. Gallery, stills, grade versions — COL
69. Group grading — COL
70. Color management / ACES — COL
71. Noise reduction (spatial / temporal) — COL
72. Film grain & creative FX (Resolve FX equivalents) — COL
73. HDR grading & delivery — COL
74. Magic Mask — COL (AI; pointer to XC)
75. Color warper — COL
76. Split-screen grade compare — COL

### Fairlight page → `15`
77. Mixer with channel strips — FAIR
78. Pan (incl. automation) — FAIR
79. Clip fades & crossfades — FAIR
80. Track EQ — FAIR
81. Dynamics (compressor/gate/limiter) — FAIR
82. Buses & submixes — FAIR
83. Meters & loudness (EBU R128) — FAIR
84. Automation lanes — FAIR
85. Voice isolation / dialogue leveler — FAIR
86. Recording / ADR — FAIR
87. Surround / spatial audio — FAIR
88. VST/AU plugins & FairlightFX — FAIR
89. Sound library — FAIR

### Deliver page → `16`
90. Render queue (multiple jobs) — DEL
91. Format/codec matrix (H.264/H.265/AV1/ProRes/DNxHR/MXF) — DEL
92. Render presets (social + custom) — DEL
93. In/out range render — DEL
94. Burn-ins & sidecar captions — DEL
95. Audio-only export — DEL
96. Quick export (any page) — DEL
97. Render in place — DEL
98. Remote / background render — DEL
99. Direct upload (YouTube/Vimeo/TikTok) — DEL

### Cross-cutting → `17`
100. Project database / library — XC
101. Collaboration (multi-user) — XC
102. Timeline interchange (EDL / FCXML / AAF / OTIO) — XC
103. Scripting & external API — XC
104. Keyboard customization — XC
105. Control surfaces / panels — XC
106. Dual-monitor workspace — XC
107. Localization — XC
108. Neural Engine AI cluster (transcription, text-based editing, smart reframe, scene detection, super scale, speed warp, relight) — XC

> Numbering above is checklist position, not feature ID. IDs are assigned inside the inventory files.

## Maintenance protocol

- When a feature ships, flip its row's status in place (`MISSING` → `PARTIAL`/`HAVE`) and add the shipping commit hash to the row's approach cell. Do not delete rows.
- Phases in `30` are re-rolled quarterly or when a re-planning trigger fires (see `30` §5 and `41`).
- New Resolve features (new Resolve releases) append to the checklist here and get new IDs; existing IDs never shift.
- The coverage matrix in [README.md](./README.md) is regenerated whenever an inventory file changes.
