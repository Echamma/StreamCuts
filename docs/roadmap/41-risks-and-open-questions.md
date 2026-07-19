# 41 — Risks & Open Questions

Register format: statement · affected · severity · mitigation · decision needed by.

## R1 — Single-main-track model vs uniform video tracks

**The headline architectural divergence.** `SceneTracks` holds one `main: VideoTrack` + typed overlays (`opencut-classic/apps/web/src/timeline/types.ts:77`); Resolve has unlimited uniform V1…Vn.

- **Affected**: EDIT-001, EDIT-014 (multicam), FUS-001 layering, any per-track color/audio data (COL-013, FAIR strips), transitions/ripple on non-main tracks. Severity: **High**.
- **Options**: (a) map V1=main, V2+=overlays and upgrade overlay semantics — cheaper, but asymmetric forever and every feature pays a "which track kind?" tax; (b) migrate to uniform `VideoTrack[]` with explicit compositing order — XL: touches types, storage migration ~#35, `commands/`, scene-builder, timeline UI, properties.
- **Mitigation/recommendation**: 1-week spike early Phase 2; **bias to (b)** — migrate *before* color grades and mixer strips attach data to tracks, or the migration cost compounds with every phase. Ship with snapshot-based rollback.
- **Decision by**: Phase 2 start.

## R2 — Binary rendering rework collision

`opencut-classic/README.md` warns preview/effects/export are being refactored ("binary rendering approach"); `AGENTS.md` confirms the Rust migration is active. Scope/timeline of that rework is unknown.

- **Affected**: every ⚠-flagged row (COL shaders, EDIT-007 compound recursion, EDIT-015 GPU transitions, DEL-010). Severity: **High**.
- **Mitigation**: Phases 0–1 renderer work is *additive registry entries only* (new `EffectDefinition`s, new WGSL — the pattern blur already proves). Any `L` renderer item requires explicit alignment with the rework owner first.
- **Decision by**: before Phase 2's renderer-layer items (COL-005/008).

## R3 — Rust-first policy tax

`AGENTS.md` mandates business logic in `rust/crates/*`. Color/audio features are UI-heavy; a literal reading forces wasm round-trips for interaction state.

- **Affected**: all COL/FAIR estimates. Severity: Medium.
- **Mitigation**: ratify the boundary **"engine math + parsers in crates; interaction state in TS"** (this roadmap assumes it; estimates price the bridge overhead for math only).
- **Decision by**: Phase 1 start.

## R4 — opencut-wasm build/publish loop — RESOLVED 2026-07-19: local-only

**Decision (owner, 2026-07-19): StreamCuts is a local-only deployment.** There is no CI, no other dev machine, and no hosted deploy consuming the repo — so the npm publish step is dropped entirely. The sanctioned workflow is the local-link one:

- `opencut-classic/package.json` carries an *uncommitted* `"overrides": { "opencut-wasm": "file:./rust/wasm/pkg" }` (plus the resulting `bun.lock` churn), and `rust/wasm/Cargo.toml` carries an *uncommitted* `wasm-opt = false`. These three local modifications stay out of every commit but are required on the machine.
- After any merge touching `rust/`, run `bun run build:wasm` from `opencut-classic/` to refresh `rust/wasm/pkg` before the new UI works. PRs that need this must say so.
- Feature code may import new `opencut-wasm` exports (e.g. `SaliencyAnalyzer`, future color-wheel entry points) directly — the published `0.2.10` no longer constrains anything. A fresh clone on another machine would need the same local setup (build wasm + add the override) before it builds; that is accepted.
- If the project ever stops being local-only (collaborator, CI, hosted deploy), re-open this risk: either publish under a package name the owner controls (`opencut-wasm` on npm belongs to upstream OpenCut — a rename such as `streamcuts-wasm` plus an import codemod would be required) or vendor `pkg/` into the repo.

- **Affected**: EDIT-016 (now unblocked), all COL shader work, FUS-005 — all buildable + verifiable locally.
- **Residual severity**: Low (setup friction on a fresh machine only).

## R5 — WebGPU dependency for scopes/NR

Compositor runs wgpu-on-WebGL2 (no compute). Scopes at full quality and temporal NR want WebGPU ([40 §2](./40-technical-feasibility.md#2-gpu-compute--readback--the-scopes-question)).

- **Affected**: COL-009, COL-015. Severity: Medium.
- **Mitigation**: dual path (WebGPU primary, CPU-tap fallback); publish a **minimum-experience statement** ("scopes at reduced precision on WebGL2-only browsers"). Target user (Windows/NVIDIA/Chromium) has WebGPU.
- **Decision by**: COL-009 implementation (P1).

## R6 — Collaboration / Postgres scaffold

Postgres/Drizzle + better-auth exist but are inactive. Activating them implies auth, sync, conflict resolution, and repositioning away from local-first.

- **Affected**: XC-001, XC-002. Severity: Low (deliberate OUT).
- **Mitigation**: recorded as OUT; re-evaluate only on an explicit product pivot. Don't delete the scaffold (feedback API uses the DB).

## R7 — Dual transcription stacks

In-browser Whisper (`apps/web/src/transcription/`) and backend faster-whisper behave differently (models, timestamps, performance).

- **Affected**: XC-009, XC-010 (text-based editing consumes word timestamps), EDIT-012 caption timings. Severity: Medium.
- **Mitigation**: one `TranscriptionProvider` interface; **backend primary when the launcher runs**, browser as fallback.
- **Decision by**: before XC-010 (Phase 4).

## R8 — Export concurrency

Render queue (DEL-001) runs serial on the main window today; background render (DEL-010) needs exporter-in-worker with OffscreenCanvas + its own wgpu context — unproven here.

- **Affected**: DEL-001 UX ("can I keep editing?"), DEL-010. Severity: Medium.
- **Mitigation**: DEL-001 v1 is serial-and-foreground by design (honest UI: "editing pauses while rendering"); DEL-010 starts with a spike, not a promise.

## R9 — Trademark / positioning

"DaVinci Resolve" is a Blackmagic Design trademark.

- **Affected**: all user-facing copy. Severity: Low, cheap to respect.
- **Mitigation**: "DaVinci-style" language stays in internal docs (this roadmap); marketing copy says "professional color grading / audio mixing", never comparative parity claims.

## R10 — Mobile gate vs pages shell

The editor hard-gates < 1024px; the pages shell adds chrome.

- **Affected**: UX-001. Severity: Low.
- **Mitigation**: gate unchanged; page bar must not regress the gate messaging; responsive pages are explicitly out of v1.

## Open questions (not risks)

1. Page bar bottom vs top — offer a position preference, or hold the Resolve-mirroring default? (Decide after UX-021 data.)
2. Boss drawer scope — global drawer on every page (current call) or Media-page-only surface?
3. Effects SDK — once COL-016 establishes shader conventions, do we document a third-party effect-definition API?
4. Proxy defaults — auto-generate proxies on import (storage cost) or on-demand (first-scrub latency)?
5. Backend job persistence — jobs are in-memory/filesystem today; does the queue (DEL-001) justify a real job store (SQLite) in the backend?
