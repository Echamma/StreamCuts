# 20 — UX: Pages Shell

The structural UX change: replace the single 14-tab workspace with **DaVinci-style pages** — purpose-built workspaces over one shared editor state.

## 1. Goals & non-goals

**Goals**: cure the 14-tab left-rail overload; give Color/Audio/Deliver room to exist as real workspaces; preserve Resolve muscle memory for users arriving from it.
**Non-goals**: this is *not* a rewrite. Pages are **layout presets over the existing panel system** (`react-resizable-panels`). The single `EditorCore` stays authoritative; pages never fork document state; switching pages is a pure view change.

## 2. Page set

**Five pages at launch: Media · Edit · Color · Audio · Deliver.** Fusion is reserved as a sixth once FUS-001 ships; **Cut is intentionally absent** (verdict in [11](./11-feature-map-cut.md)).

- **Page bar**: fixed strip (~40px, `--page-bar-h`) anchored to the **bottom edge**, below the timeline — mirroring Resolve's placement. Icons + labels, active state in `--primary`.
- **Shortcuts**: `Shift+1…Shift+5` (Media→Deliver), registered as actions in `opencut-classic/apps/web/src/actions/definitions.ts` — rebindable like everything else (XC-005). Conflict check against existing defaults required at implementation time.

## 3. Architecture

Extends three existing seams — no new state paradigm:

1. **`PageId` union + layout registry.** Generalize `PANEL_CONFIG` in `opencut-classic/apps/web/src/panels/layout.ts` from a single `{panels: {tools, preview, properties, mainContent, timeline}}` to `Record<PageId, PageLayoutSpec>` (which panels exist, defaults, min/max).
2. **Persistence.** `opencut-classic/apps/web/src/editor/panel-store.ts` (Zustand persist `panel-sizes`, currently **version 2**) migrates v2→v3: sizes keyed per page; v2 sizes become the Edit page's. Last-active page persists per project in the session view state (`core/managers/session-view-state-store.ts`).
3. **Page switcher** renders in the editor chrome (sibling of `components/editor/editor-header.tsx` content); pages mount/unmount panel subtrees while `EditorCore` persists.

**Migration invariant**: the Edit page is the current layout **verbatim** — a user who never leaves Edit sees zero change.

Per-page workspaces:

| Page | Left | Center | Right | Bottom |
|---|---|---|---|---|
| Media | storage/watched folders | media pool (full-width grid/list + tape view later) | clip inspector/metadata | AI ingest surface (boss/long-to-short/summarize jobs) |
| Edit | asset tabs (slimmed, §4) | preview | properties | timeline |
| Color | gallery/stills + LUT browser | preview + scopes dock | grade controls (wheels/curves/qualifier) | grade-node stack + timeline filmstrip |
| Audio | sounds library | preview (small) | track strip detail (EQ/dynamics) | **mixer** + timeline (audio-focused) |
| Deliver | presets | preview of selected job | job settings | **render queue** |

## 4. The 14-tab redistribution

Disposition of every `TAB_KEYS` entry in `opencut-classic/apps/web/src/components/editor/panels/assets/assets-panel-store.tsx`:

| Tab | Disposition |
|---|---|
| media | Media page primary surface; stays a compact Edit-page tab too |
| sounds | Media + Audio pages |
| audio-mixer | **Promoted**: becomes the Audio page's primary bottom surface (FAIR-001), no longer a left tab |
| text | Edit page tab |
| stickers | Edit page tab |
| effects | Edit page tab (per-clip); Color page hosts grade-specific controls |
| transitions | Edit page tab |
| captions | Edit page tab |
| adjustment | Edit page tab, shipped for real with EDIT-019 (placeholder today) |
| boss | **Global right-edge drawer**, available on every page (job status persists across pages) |
| summarize | Media page (AI ingest surface) |
| long-to-short | Media page (AI ingest surface) |
| socials | Deliver page (copy handoff next to export) |
| settings | **Header menu**, out of the rail entirely |

Net Edit-page rail: 7–8 tabs instead of 14.

## 5. Interaction contracts

- **State survives switches**: selection, playhead, undo history, in-flight export/transcription jobs are page-independent. Switching to Color with a clip selected shows *that clip's* grade.
- **Deep links**: `?page=color` on the editor route; the page bar is the source of truth.
- **Per-page panel rules** live in the layout registry, not components.
- **Mobile gate** (<1024px) unchanged (risk R10) — pages don't attempt responsive collapse in v1.
- **a11y**: the page bar is a `tablist` with arrow-key navigation; jsx-a11y rules apply.

## 6. Rollout

Feature-flagged (`pages-shell`). Phase 0 ships: shell + Edit-as-today + Media/Deliver rearrangements (their features already exist — it's relocation). Color/Audio pages appear when their Phase 1 panels land (COL-002, FAIR-001) — an empty page ships nothing. Flag defaults on only after the usability gate in [22 §4](./22-ux-research.md) passes.

## 7. UX inventory (shell)

| ID | Item | Status | Anchor | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|
| UX-001 | Pages shell frame (PageId, layout registry, switcher) | MISSING | `panels/layout.ts` | browser-native | M | 0 |
| UX-002 | panel-store v2→v3 per-page persistence | MISSING | `editor/panel-store.ts` | browser-native | S | 0 |
| UX-003 | Tab redistribution + Media/Deliver page arrangements | MISSING | assets panel views | browser-native | M | 0 |
| UX-004 | Page-switch actions + shortcuts | MISSING | `actions/definitions.ts` | browser-native | S | 0 |
| UX-005 | Deep links + last-page persistence | MISSING | session view state | browser-native | S | 0 |
| UX-006 | Boss global drawer | MISSING | `components/editor/panels/boss/` | browser-native | M | 0 |
| UX-007 | Settings → header menu | MISSING | header + settings view | browser-native | S | 0 |
