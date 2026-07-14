# 22 — UX Research: Personas, Journeys, Usability Plan

## 1. Method & evidence level

**These personas are provisional (assumption-based).** They are derived from what the product objectively is (a local-first Windows tool with a GPU transcription backend, AI clip pipelines, and a browser editor) and from the git history's direction — not from interviews. Confidence: **Low (exploratory)** per standard persona-validity criteria. Validation plan: §4's sessions double as persona checks ("does this sound like you?"), targeting 5+ participants per primary persona before any persona-driven cut of the roadmap is treated as fact.

## 2. Personas

### P1 — "Eli, the Clip Farmer" (primary)

Solo creator on a Windows/NVIDIA rig who repurposes 1–3 h podcasts/VODs into daily shorts. Launches via the desktop launcher; lives in the boss/long-to-short pipelines, caption presets, platform export presets.

- **Goals**: 10 publishable shorts/day without leaving the machine; captions that look like Beast/Hormozi styles without hand-animating; hands-off vertical reframing.
- **Behaviors**: batch mindset — queue work, walk away; rarely touches keyframes; picks presets over parameters.
- **Pains (current)**: caption animation presets exist but don't render (EDIT-012); one export at a time (DEL-001); reframe is manual (EDIT-016); features hide across 14 tabs (UX-003); upload is manual (DEL-011, OUT).
- **Quote**: *"I don't edit. I process."*
- **Pages**: Media → Edit (light touch-up) → Deliver.
- **Roadmap items that serve Eli**: EDIT-012, EDIT-016, DEL-001, DEL-002, MED-013, XC-014, UX-003/006.

### P2 — "Mara, the Prosumer Editor" (primary)

DaVinci-literate YouTuber who wants Resolve-grade color and audio polish without Resolve's weight, license gates, or render times. Edits multi-scene videos with keyframes and masks today.

- **Goals**: grade her footage (wheels, curves, LUTs) and mix audio (fades, EQ, meters) in one tool; trim like a pro (roll/slip/slide); trust the export to match the preview.
- **Behaviors**: keyboard-driven; inspects scopes before publishing; keeps preset LUT packs.
- **Pains (current)**: **zero color tools** (COL-*), no mixer or meters (FAIR-001/007), missing roll/slip/slide (EDIT-002), no markers with notes (EDIT-005), crowded left rail.
- **Quote**: *"I export to Resolve just to grade, then re-export. It's absurd."*
- **Pages**: Edit → Color → Audio → Deliver.
- **Roadmap items**: COL-002/004/005/008/009, FAIR-001/002/003/007, EDIT-002/005, DEL-003.

### P3 — "Kai, the Workflow Tinkerer" (secondary)

Dev-adjacent power user automating ingest→publish. Runs the launcher, reads the backend logs, sets `FASTER_WHISPER_*` env vars by hand.

- **Goals**: watch-folder → transcribe → plan → render without clicking; scriptable exports; stable local APIs.
- **Pains (current)**: no automation surface (XC-004); duplicate transcription stacks with different behavior (XC-009/R7); backend job state is per-request only.
- **Quote**: *"If it has an endpoint, I can make it a pipeline."*
- **Roadmap items**: XC-003/004/009, DEL-001 (queue as API), launcher orchestration.

## 3. Journey maps

### J1 — "Long video → published short" (Eli)

| Stage | Actions | Tools touched | Feels | Pains → IDs | Opportunity |
|---|---|---|---|---|---|
| Launch | Double-click launcher | `launcher/`, backend `:4000` | routine | — | — |
| Import | Upload 2 h VOD | boss upload (8 GB limit) | fine | — | — |
| Plan | Transcribe (GPU) + Gemini chapters/shorts | boss panel, faster-whisper | *waiting, no feedback depth* | job progress is coarse | richer job telemetry on Media page |
| Review clips | Scrub proposed shorts | boss step UI | engaged | clips land as files, not timeline-native | "open short as scene" |
| Captions | Apply preset style | captions panel | **frustrated** | presets don't animate (EDIT-012) | P1 quick win |
| Reframe | Manually keyframe 9:16 crop | reframe params | **tedious** | auto-reframe unwired (EDIT-016) | P1 quick win |
| Export | One preset at a time, babysits each | export popover | **blocked** | no queue (DEL-001) | P1 flagship |
| Publish | Manual upload + paste AI copy | socials tab | resigned | DEL-011 OUT (accepted) | copy handoff on Deliver page |

Future state (post-P1): plan on **Media**, style on **Edit** (captions render), queue all shorts on **Deliver**, walk away. The journey drops from ~8 attended steps to ~4.

### J2 — "Manual edit with color + audio polish" (Mara)

| Stage | Actions | Tools touched | Feels | Pains → IDs | Opportunity |
|---|---|---|---|---|---|
| Import/assemble | Pool → timeline, scenes | media panel, timeline | good | — | — |
| Trim pass | Split/trim/ripple | commands, JKL | good until precision work | no roll/slip/slide (EDIT-002), no markers w/ notes (EDIT-005) | P1 |
| **Color** | *exports to another tool* | — | **defeated — the exit point** | COL-* all missing | P1 wheels + scopes end the exit |
| **Audio mix** | rough per-clip dB only | volume line | frustrated | no mixer/fades/meters (FAIR-001/003/007) | P1 mixer |
| Deliver | single export, checks by ear/eye | export popover | anxious | no loudness (FAIR-008), no queue | P3 loudness |

**This journey is the roadmap's emotional core**: today it *cannot be completed inside StreamCuts*. Phase 1's exit criterion is exactly "J2 end-to-end at basic quality" ([30 §2](./30-phased-plan.md)).

## 4. Usability test plan — pages shell gate

**Research questions**: After redistribution, do users find relocated features? Is the bottom page bar discoverable? Does switching pages feel stateful and safe (selection/playhead survive)?

- **Method**: moderated remote, think-aloud; **6–8 participants** (4 Eli-like short-form creators, 3 Mara-like editors); Phase 0 flagged build; 45 min sessions.
- **Pre-build check**: a **closed card sort** (UX-020) of the 14 tabs against the five pages with 8–10 users — validates `20` §4's redistribution *before* code.
- **Tasks** (scenario-phrased, success criteria fixed):
  1. Export this project as a TikTok short.
  2. Add a caption style to this clip.
  3. Open the mixer and pan a clip left.
  4. Apply a LUT to this clip. *(post-P1 build)*
  5. Find project settings.
  6. Add a marker with a note at the playhead.
  7. Queue two different exports of the same scene.
  8. Switch to Color and back — is your clip still selected? *(probe: did that feel safe?)*
- **Metrics & pass thresholds**: task success **≥ 80%**; first-click on the correct page **≥ 70%**; SUS **≥ 68**; time-on-task < 2× baseline (current build where comparable).
- **Severity scale**: 4 = blocks completion (fix before flag-default) · 3 = major difficulty (fix before phase exit) · 2 = hesitation (backlog) · 1 = cosmetic.
- **Outputs**: findings with severity + affected UX/feature IDs; failed thresholds re-open `20` §4 decisions (that's the re-planning trigger in `30` §5).

| ID | Item | Status | Effort | Phase |
|---|---|---|---|---|
| UX-020 | Closed card sort of tab redistribution | MISSING | S | 0 (pre-build) |
| UX-021 | Moderated usability round (gate for flag-default) | MISSING | M | 0 (gate) |
