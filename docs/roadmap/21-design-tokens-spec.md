# 21 — UX: Design Token Specification

Consolidates the existing look into a complete token system. **This is gap-filling, not a rebrand**: the plumbing (Tailwind v4 CSS-first `@theme inline`, CSS-var tokens, `next-themes`) is modern and stays. Single source of truth remains `opencut-classic/apps/web/src/app/globals.css`.

## 1. Principles

- **Keep the brand**: `--primary: hsl(200, 90%, 52%)` (sky blue, `globals.css:18`) stays the accent.
- **Role-named tokens** (`--surface-1`, `--z-modal`), never value-named (`--blue-500` style scales only as raw material).
- **Both themes always**: every new token gets a `:root` and `.dark` value; contrast pairs meet WCAG AA (4.5:1 text, 3:1 large/UI).
- **No raw values in components**: after the sweep (UX-018), any hex/rgb/z-integer outside `globals.css` (and the two palette files below) is a lint error (UX-019).

## 2. New token categories

Add inside/alongside `@theme inline` (`globals.css:148`):

```css
/* z-index — replaces ad-hoc z-10…z-999 */
--z-base: 0;          /* canvas, timeline content */
--z-sticky: 100;      /* toolbars, track headers, playhead */
--z-dropdown: 1000;   /* menus, selects, context menus */
--z-overlay: 1200;    /* drag overlays, panel scrims */
--z-modal: 1300;      /* dialogs, sheets */
--z-popover: 1400;    /* popovers above modals (export popover) */
--z-toast: 1500;
--z-tooltip: 1600;

/* elevation — replaces ad-hoc shadow-lg + hand-tuned shadows */
--shadow-sm: 0 1px 2px rgb(0 0 0 / 0.10);
--shadow-md: 0 2px 8px rgb(0 0 0 / 0.14);
--shadow-lg: 0 8px 24px rgb(0 0 0 / 0.18);
--shadow-overlay: 0 12px 40px rgb(0 0 0 / 0.28);
/* .dark: same geometry, higher alpha (shadows read weaker on dark) */

/* layout semantics — consumed by the pages shell (20 §2) */
--panel-gap: 0.25rem;
--toolbar-h: 2.5rem;
--page-bar-h: 2.5rem;
--track-h: 3.25rem;

/* focus & motion */
--focus-ring: 0 0 0 2px var(--background), 0 0 0 4px var(--primary);
--duration-fast: 120ms;
--duration-base: 200ms;
--duration-slow: 320ms;
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
```

Current mapping of ad-hoc usage → tokens (from the audit): dialog/sheet `z-250`→`--z-modal`, dropdown `z-50`→`--z-dropdown`, header dropdown `z-100`→`--z-dropdown`, draggable item `z-999`→`--z-overlay`, toast `z-100`→`--z-toast`.

## 3. Surface model — collapsing the dual `.panel` layer

Today there are **four** theme contexts: `:root`, `.dark`, `.panel` (`globals.css:52`), `.dark .panel` (`globals.css:102`) — each re-overriding background/card/muted/accent/border. Replace with numbered surfaces both themes define once:

| Token | Role | Replaces |
|---|---|---|
| `--surface-0` | App chrome (page background, headers, page bar) | `:root --background` |
| `--surface-1` | Panels (assets/properties/timeline containers) | `.panel --background` overrides |
| `--surface-2` | Raised elements (cards, popovers, dropdowns, inputs on panels) | `.panel --card`/`--popover` overrides |

Migration: components reference surfaces directly (`bg-surface-1`); the `.panel` class becomes a thin alias (`--background: var(--surface-1)` …) during transition, deleted when the last `className="panel"` is gone. Borders join in: `--border-subtle` (within a surface) / `--border-strong` (between surfaces).

## 4. Domain tokens

**Timeline element colors** — lift the hardcoded hexes from `opencut-classic/apps/web/src/timeline/components/theme.ts` into tokens (values initially unchanged, so no visual diff):

```css
--element-text: #5DBAA0;     /* was bg-[#5DBAA0] */
--element-audio: #8F5DBA;
--element-graphic: #BA5D7A;
--element-effect: #5d93ba;
--element-video: /* current media clip color */;
--bookmark: #009dff;         /* DEFAULT_TIMELINE_BOOKMARK_COLOR */
```

Each gets `-muted` (disabled/inactive) and `-hover` variants derived at definition, not per-component.

**Scopes & meters palette** — a **fixed, theme-independent** dataviz set (scopes always render on a dark surface, like every grading tool):

```css
--scope-bg: hsl(220 10% 8%);
--scope-graticule: hsl(220 8% 28%);
--scope-trace-r: hsl(0 85% 60%);
--scope-trace-g: hsl(140 70% 55%);
--scope-trace-b: hsl(210 90% 62%);
--scope-trace-luma: hsl(0 0% 82%);
--meter-ok: hsl(140 70% 45%);      /* < -18 dBFS */
--meter-warn: hsl(38 92% 50%);     /* -18…-6 */
--meter-hot: hsl(0 83% 55%);       /* > -6 / clip */
```

Consumed by COL-009 scopes and FAIR-007/008 meters; validated for contrast against `--scope-bg` before shipping.

## 5. Gradient policy

**Retire the bespoke export-button gradient** (`#2567EC→#37B6F7` + hardcoded shadow in `opencut-classic/apps/web/src/components/editor/export-button.tsx`). Decision: **flat `--primary`** for the export CTA — the gradient reads as legacy OpenCut, duplicates what `--primary` should own, and is the single largest token bypass. No sanctioned gradient token unless a future brand pass introduces one deliberately.

## 6. Button reconciliation

`opencut-classic/apps/web/src/components/ui/button.tsx` has 10 variants, an **inverted `default`** (`bg-foreground text-background`), and **no `primary`** — so the brand color barely appears on buttons. Restore the shadcn contract:

| Current variant | Disposition |
|---|---|
| `default` (inverted) | **Rename → `contrast`**; `default` becomes filled `--primary` (the new primary CTA) |
| `background` | Merge → `ghost` or `outline` per call-site (it's a neutral fill) |
| `destructive` | Keep |
| `destructive-foreground` | Rename → `destructive-outline` |
| `caution` | Keep (semantic amber exists: `--caution`) |
| `outline` | Keep |
| `secondary` | Keep |
| `text` | Merge → `link` or `ghost` per call-site |
| `ghost` | Keep |
| `link` | Keep |

Execution is a grep-able codemod (each rename is mechanical); the export button then becomes `<Button variant="default">` and UX-015 falls out for free. Sizes stay as-is.

## 7. Cleanup register (token-adjacent debt)

| Item | Action |
|---|---|
| Two toast systems (`components/ui/sonner.tsx` + `components/ui/toast.tsx`) | Keep **sonner**, migrate/remove the other |
| Dead dependency `@hello-pangea/dnd` (zero imports) | Remove from `apps/web/package.json` |
| Bug: `"{n} elements selected.0"` | Fix stray literal at `components/editor/panels/properties/index.tsx:37` |
| Shipped placeholders ("Adjustment coming soon", "Freeze frame (coming soon)") | Hide behind flags until EDIT-019/EDIT-021 ship |
| ~58 hardcoded colors across 17 files | Sweep to tokens; generate the file list with `rg -n '#[0-9a-fA-F]{3,8}\b|rgba?\(' apps/web/src --type ts --type tsx` and burn it down |
| Icon sprawl (4 icon sources) | Document hugeicons as primary; no new lucide/react-icons imports in editor chrome |

## 8. Adoption & guardrails

1. Land tokens + surface aliases (no visual change), then migrate per-area: chrome → panels → timeline → dialogs.
2. **Lint guardrail (UX-019)**: CI grep (or Biome rule) failing on raw hex/rgb/z-index literals under `apps/web/src/**` outside `globals.css`, `timeline/components/theme.ts` (until migrated), and the scope palette definition.
3. Visual regression: before/after screenshots of the four panels in both themes per migration PR.

## 9. UX inventory (tokens)

| ID | Item | Status | Anchor | Feasibility | Effort | Phase |
|---|---|---|---|---|---|---|
| UX-010 | Token scales: z-index, shadows, layout, focus, motion | MISSING | `globals.css` | browser-native | S–M | 0 |
| UX-011 | Surface model (collapse `.panel` dual layer) | MISSING | `globals.css:52,102` | browser-native | M | 0 |
| UX-012 | Timeline element color tokens | MISSING | `timeline/components/theme.ts` | browser-native | S | 0 |
| UX-013 | Scopes/meters dataviz palette | MISSING | new palette block | browser-native | S | 0 |
| UX-014 | Button reconciliation + codemod | MISSING | `components/ui/button.tsx` | browser-native | M | 0 |
| UX-015 | Export gradient retirement | MISSING | `components/editor/export-button.tsx` | browser-native | S | 0 |
| UX-016 | Toast unification (sonner only) | MISSING | `components/ui/` | browser-native | S | 0 |
| UX-017 | Dead dep + `properties/index.tsx:37` bug + placeholder flags | MISSING | see register | browser-native | S | 0 |
| UX-018 | Hardcoded-color sweep | MISSING | 17 files (grep list) | browser-native | M | 0 |
| UX-019 | Lint guardrail against raw values | MISSING | CI / Biome config | browser-native | S | 0 |
