# 11 — Feature Map: Cut Page

**Resolve's Cut page** is an alternate, speed-focused editing UI over the same timeline: source tape, fast review, smart edit actions, sync bin, quick export.

## Verdict: no Cut page in StreamCuts — folded into Edit + Media

The Cut page exists because scrubbing bins and assembling a first cut manually is slow. **StreamCuts attacks the same problem with AI**: the long-to-short / boss pipelines (MED-013) produce a planned first cut from a transcript, which is faster than any manual fast-assembly UI. Building a second editing workspace would double UI surface for a workflow the product already automates. The genuinely useful Cut tools are inventoried below as additions to the Edit/Media pages; the pages shell reserves no Cut tab (`20` §2).

| ID | Resolve feature | Status | StreamCuts anchor | Proposed approach | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|---|
| CUT-001 | Source tape (all media as one scrubbable strip) | MISSING | media panel (`components/editor/panels/assets/`) | "Tape" view mode in the Media page pool: concatenated scrub strip with in/out marking → insert to timeline | browser-native | M | 4 |
| CUT-002 | Fast review (speed scales with clip length) | PARTIAL — JKL shuttle exists | `actions/definitions.ts`, playback manager | Review mode that auto-scales shuttle rate; small playback-manager addition | browser-native | S | 4 |
| CUT-003 | Smart insert / append / place-on-top / close-up | MISSING | `commands/timeline/` | Edit actions with playhead-proximity targeting; close-up = programmatic punch-in (transform preset). Pure command-layer work, valuable from the keyboard | browser-native | M | 3 |
| CUT-004 | Sync bin | OUT until multicam (EDIT-014) exists — it's a multicam view | — | — | — | — | — |
| CUT-005 | Boring detector / cut suggestions | OUT — superseded by the Gemini planning pipelines (XC-014), which do this better with a transcript | — | — | — | — | — |
| CUT-006 | Quick export from Cut | HAVE (equivalent) — header quick-export serves every page | pointer to DEL-008 | — | — | — | — |

## Rollup

- Rows: 6 → HAVE 1 · PARTIAL 1 · MISSING 2 · OUT 2
- Nothing here is Phase-1-critical; CUT-003's smart edit commands are the first worth shipping (P3, keyboard-driven assembly).
