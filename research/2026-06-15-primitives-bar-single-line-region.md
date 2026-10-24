# Bar primitive — factor the single-line chrome-strip archetype + enforce it

## Context

The "horizontal, single-line region" pattern (`items-center` + `gap` + never-wrap)
is re-rolled independently across primitives instead of sharing a home. The worst
offender is the **chrome bar** archetype: three places hand-roll a near-identical
toolbar/header strip with **no shared primitive and no enforcement**:

- `AppShellLayout` toolbar (app-shell) and `PaneToolbar.Host` (pane-toolbar) carry a
  **byte-identical** className:
  `flex items-center whitespace-nowrap border-b pl-chrome pr-floating-bar h-chrome-bar gap-sm bg-background overflow-hidden`
- `PaneChrome`'s header band is a near-twin (swaps `h-chrome-bar`→`h-chrome-pane`,
  `pl-chrome pr-floating-bar`→`px-chrome`, adds `min-w-0`, conditional overflow).

`Row` is guarded by `no-adhoc-row` so row-shaped markup must route through the
primitive — but there is **no equivalent for bars**, so the next hand-rolled
toolbar silently reintroduces the duplication (and the wrap bug). `pane-toolbar`'s
own description even says "use instead of hand-rolling a header bar" — yet
app-shell hand-rolls the identical bar beside it because there is no `Bar` to compose.

**This is a factor-not-collapse problem.** A bar, a row, and a chip have genuinely
different concerns and must NOT be merged into one mega-component. The three bars
also differ in **what they host** (PaneChrome owns title/promote/close; the
app-shell toolbar owns the sidebar trigger; pane-toolbar owns reorderable
start/end zones) — so `Bar` owns ONLY the chrome strip; each consumer keeps its
own hosted content.

**Goal of this plan (Bar-focused scope):**
1. Put the single-line invariant in **one place** — a `region-line` CSS `@utility`.
2. Create the missing **`Bar`** primitive (the chrome strip container) and converge
   the three bars onto it.
3. Add the missing enforcement — a **`no-adhoc-bar`** lint rule modeled on
   `no-adhoc-row`.

The chip group (Badge/ToggleChip/LinkChip) and the row-core duplication
(CollapsibleTrigger/CollapsibleCard) are **deliberately out of scope** — they are
filed as separate investigation tasks (`task-…qz13jj` chip, `task-…a5mtss` row)
because their divergence has a different root cause and forcing convergence now is
premature.

## Approach

### 1. Shared invariant: `region-line` CSS `@utility`

**File:** `plugins/primitives/plugins/ui-kit/web/theme/app.css` (alongside the
existing `icon-auto` @utility).

Add:

```css
@utility region-line {
  @apply items-center whitespace-nowrap;
}
```

This is the precise, minimal single-line invariant duplicated ~10×. It does **not**
include `flex` (Badge uses `inline-flex`), `items-baseline` (Breadcrumb), or the
`icon-auto` svg selector (icon-sizing is a separate, already-governed concern — and
folding it in risks regressing toolbar icon sizes). Consumers add their own
`flex`/`inline-flex`.

`Row` adopts it immediately to prove the home is real (not a Bar-private string):
in `plugins/primitives/plugins/row/web/internal/row.tsx`, replace the inline
`items-center whitespace-nowrap` in the base className with `region-line`.

### 2. New `Bar` primitive

**New plugin:** `plugins/primitives/plugins/bar/` (leaf — imports only `cn` from
ui-kit; no cross-plugin edges into app-shell/pane/pane-toolbar, so no cycle).

`web/internal/bar.tsx` — a presentational chrome-strip container, **no slots, no
zones** (consumers keep those):

```tsx
type BarTier = "chrome" | "pane";

interface BarProps extends React.HTMLAttributes<HTMLElement> {
  tier?: BarTier;                  // "chrome" (default) | "pane"
  overflow?: "hidden" | "visible"; // default "hidden"; PaneChrome headerSpill → "visible"
  as?: React.ElementType;          // optional override; defaults from tier
  className?: string;
  children: React.ReactNode;
}
```

className mapping (the only knowledge Bar owns):

| | shared | chrome tier | pane tier |
|---|---|---|---|
| classes | `flex region-line border-b gap-sm` | `h-chrome-bar pl-chrome pr-floating-bar bg-background` | `h-chrome-pane px-chrome min-w-0` |
| element | — | `<header>` | `<div>` |

- `overflow` → `overflow-hidden` / `overflow-visible`.
- All other props (`onDoubleClick`, drag-handle spreads, `cursor-grab` via
  `className`) flow through `...rest` + `cn(...)` — keeps Bar dumb and lets
  PaneChrome forward its `PaneLayoutContext` drag wiring unchanged.

`web/index.ts` — barrel exporting `Bar` + `BarProps` (+ `default definePlugin`).

### 3. Converge the three consumers

- **app-shell** (`app-shell-layout.tsx:99`):
  `<header className="flex items-center whitespace-nowrap …">` →
  `<Bar tier="chrome">{sidebarSlot && <SidebarTrigger/>}<toolbarSlot.Render>…</Bar>`.
- **pane-toolbar** (`define-pane-toolbar.tsx:83` `Host`):
  `<header className={cn("flex items-center …", className)}>` →
  `<Bar tier="chrome" className={className}>`, keeping the
  `Start.Render` / `ml-auto` / `End.Render` zone structure as children.
- **pane** (`pane-chrome.tsx:66` header band):
  the `<div className={…}>` → `<Bar tier="pane" overflow={headerSpill ? "visible" : "hidden"}
  onDoubleClick={layoutCtx?.onDoubleClickHeader} className={dragHandle ? "cursor-grab active:cursor-grabbing" : undefined} {...layoutCtx?.dragHandleProps}>`,
  keeping title / left actions slot / `OverflowActionsBar` / promote / close as children.

### 4. New `no-adhoc-bar` lint rule

**Files:** `plugins/primitives/plugins/bar/lint/no-adhoc-bar.ts` +
`plugins/primitives/plugins/bar/lint/index.ts`. Auto-registered repo-wide by the
root `eslint.config.ts` walk (run by the `eslint`/`type-check` check) — no registry edit.

Modeled byte-for-byte on `plugins/primitives/plugins/row/lint/no-adhoc-row.ts`
(same `createRule` shape, single `JSXAttribute` visitor, simple `collectTokens`
walk, no auto-fix).

**Fingerprint** (the chrome-height tokens are the smoking gun — they exist only for
chrome bars, so false positives are near-zero):

- host tag ∈ `{ header, div }`
- co-occurs: a chrome height token (`h-chrome-bar` | `h-chrome-pane`)
- AND (`flex` OR `border-b`)

Message: route through the `Bar` primitive. Escape hatch: an
`eslint-disable-next-line bar/no-adhoc-bar -- <reason>` for genuinely special
strips (and Bar's own internal file). Barrel:
`{ name: "bar", rules: { "no-adhoc-bar": rule }, ignores: { "no-adhoc-bar": [] } }`.

### 5. Sweep fallout

After converging, run `./equin check eslint` (or the lint check). Any other
existing hand-rolled `h-chrome-*` strip the new rule catches gets routed through
`Bar` (or `eslint-disable`d with a named structural reason if genuinely special).
Exploration found only the three known bars, but the rule may surface more.

## Out of scope (filed as tasks)

- **Chip convergence** — `task-…qz13jj`. Badge/ToggleChip/LinkChip diverge on
  role-essential axes (radius `md` vs `full`, control-size participation, inline
  baseline + inner truncate). `region-line` already shares their single-line slice;
  whether a `Chip` base is worth it is left to investigation.
- **Row-core duplication** — `task-…a5mtss`. CollapsibleTrigger / CollapsibleCard
  header re-roll Row's core but can't compose `Row` (bare-wrapper / overlay-button
  architectures). `region-line` shares the invariant; a deeper row-core is left to
  investigation.

Explicitly **not** touched: `section-label`, `breadcrumb`, `tabbed-view` tabs —
their `whitespace-nowrap` is incidental (typography / `items-baseline` inline text /
intentional `flex-1 justify-center` layout), not the chrome-strip archetype.

## Implementation notes (discovered while building)

- **A 4th bar existed:** `pane/web/components/pane-resolve-guard.tsx` renders a
  pane-tier loading header (title + promote + close) — converged onto `<Bar tier="pane">`.
- **An adjacent guard already existed:** `pane-toolbar/no-adhoc-pane-toolbar`
  (fingerprint `border-b` + `pr-floating-bar`) guarded the *toolbar* tier (slot-host
  concern) but NOT the pane-header tier. `no-adhoc-bar` is the lower, general layer
  ("any chrome strip → Bar", keyed on the chrome-height tokens) and closes the
  pane-header gap. The two layer cleanly; `no-adhoc-pane-toolbar`'s `ignores` was
  repointed from the now-converged hosts to `bar.tsx` (the sole signature wearer).
- `region-line` required (a) registration in `ui-kit/web/theme/custom-utilities.ts`
  (the `app-css-utilities-in-sync` check) and (b) adding it to
  `no-clip-without-nowrap`'s `NOWRAP` set (it bakes in `whitespace-nowrap`).

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/ui-kit/web/theme/app.css` | add `region-line` @utility |
| `plugins/primitives/plugins/bar/web/internal/bar.tsx` | **new** — `Bar` component |
| `plugins/primitives/plugins/bar/web/index.ts` | **new** — barrel |
| `plugins/primitives/plugins/bar/lint/no-adhoc-bar.ts` | **new** — lint rule |
| `plugins/primitives/plugins/bar/lint/index.ts` | **new** — lint barrel |
| `plugins/primitives/plugins/row/web/internal/row.tsx` | adopt `region-line` |
| `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` | use `Bar` (chrome) |
| `plugins/primitives/plugins/pane-toolbar/web/internal/define-pane-toolbar.tsx` | use `Bar` (chrome) in `Host` |
| `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` | use `Bar` (pane) for header band |

## Verification

1. `./equin build` — regenerates the plugin registry + docs for the new `bar`
   plugin (keeps `plugins-registry-in-sync` / `plugins-doc-in-sync` green) and runs checks.
2. `./equin check` — `eslint` (new `no-adhoc-bar` active + no other rule broken),
   `type-check`, `plugin-boundaries` (Bar is a clean leaf), all green.
3. **Negative test for the rule:** temporarily paste a hand-rolled
   `<div className="flex h-chrome-bar border-b …">` into any web file and confirm
   `./equin check eslint` flags `bar/no-adhoc-bar`; remove it.
4. **Visual regression** at `http://att-1781510656-kl0v.localhost:9000` via Playwright
   (`bun e2e/screenshot.mjs`): confirm pixel-identical
   (a) the agent-manager top toolbar (app-shell), (b) a pane header with
   promote/close + drag-to-reorder + double-click-maximize still work (pane-chrome),
   (c) a pane-toolbar header with start/end zones and reorder edit mode.
5. Optional: a `bun:test` unit test for `no-adhoc-bar` (positive + escape-hatch +
   the `border-b`-only / chrome-height-only negative cases), co-located next to the rule.
