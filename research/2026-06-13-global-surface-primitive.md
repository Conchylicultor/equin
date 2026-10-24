# Surface primitive — semantic elevation roles + `no-adhoc-surface` lint

## Context

Across the app, every plugin invents its own surfaces with raw Tailwind
(`bg-card`, `bg-popover`, `bg-background`, `bg-muted`, `border`, `shadow-*`,
`rounded-*`). The result is a flat, box-in-box, generic look with no consistent
depth or elevation: a theme/preset swap only repaints the color vars but cannot
fix *which* background pairs with *which* shadow/radius/border, because that
bundle is decided ad-hoc at every call site. There is no chokepoint forcing
plugins through the existing `tokens/shadow` + `tokens/shape` tokens, so
consistency regresses every time an agent writes UI in parallel.

**Is it still relevant?** Yes. Audit of `plugins/**/web/**/*.tsx`: ~295 files
carry raw surface classes; ~80–120 are genuine surface *containers*. Two of the
three classic roles are already partly centralized — `raised` by the `Card`
primitive (`rounded-md border border-border bg-card p-3` + select-scope, with a
`no-adhoc-card` lint rule), and `overlay` by shadcn `PopoverContent` /
`DropdownMenuContent` (`bg-popover shadow-md ring-1 ring-foreground/10
rounded-lg`). But **`base` (page/pane planes) and `sunken` (recessed wells) have
no home at all**, `Card` is bypassed in ~8+ `bg-card` sections, and ~10 non-Radix
overlays open-code the popover recipe. Three separate partial homes each keep
their own copy of the recipe → drift.

**Intended outcome.** One typed `<Surface level>` primitive backed by the
existing tokens, exposing a closed set of 4 semantic elevation roles. `Card` and
the shadcn overlay components are refactored to compose it (single source of
truth). A `no-adhoc-surface` lint rule (subsuming `no-adhoc-card`) makes the
open-coded raised/overlay recipe a build error — mirroring the
`control-size`+`no-adhoc-control` and `z-layers`+`no-adhoc-zindex` precedent.

## The closed level set

Four frozen roles, each a bundle of `(background, shadow)` backed 1:1 by existing
tokens (containment — border/radius — added per role; see Implementation):

| level     | background          | shadow      | border + radius        | role in this app |
|-----------|---------------------|-------------|------------------------|------------------|
| `sunken`  | `--muted`           | none        | none (well/band)       | app-shell main area, tool-call/summary wells (`bg-muted/30`) |
| `base`    | `--background`      | none        | none (plane/band)      | panes, toolbar bands, sticky headers, side columns |
| `raised`  | `--card`            | `--shadow-sm` | `1px --border` + `rounded-md` | cards, sections (absorbs `<Card>`) |
| `overlay` | `--popover`         | `--shadow-md` | ring `1px foreground/10` + `rounded-lg` | popovers, menus, floating bars, dialogs |

Backed by tokens already in `app.css @theme inline`: `--background/--card/
--popover/--muted/--border` (color-palette group), `--shadow-sm/--shadow-md`
(shadow group), `--radius-md/--radius-lg` derived from `--radius` (shape group).
A shadow/shape/color preset swap now moves every surface of a role *together* —
that is the entire point.

## Design decisions (resolved with user)

1. **Substrate, refactor others onto it.** Surface is THE bundle. `Card` becomes
   `Surface(raised) + p-card + select-scope`; the shadcn overlay components
   consume the `surface-overlay` recipe. One source of truth for elevation.
2. **4 levels** including `sunken` as a first-class role (heavily used as
   recessed `bg-muted` wells), even though it and `base` are component-only (not
   hard-linted — see #3).
3. **One `no-adhoc-surface` rule subsumes `no-adhoc-card`**, firing on the two
   *disambiguable* fingerprints (raised + overlay). `base`/`sunken` are offered
   as components but NOT hard-linted: `bg-background`/`bg-muted` legitimately
   appear on dividers, hover states, chips, and drop-zones, so they can't be
   fingerprinted without false positives (same reasoning the existing
   `no-adhoc-card` gives for keying on `bg-card`, not the broader tokens).

> **Implementation note (as built).** The frozen bundles are a TS class-map
> `SURFACE_LEVELS` in `ui-kit/web/theme/surface.ts` (exported from the ui-kit
> barrel), **not** a multi-property CSS `@utility`. A multi-property `@utility` +
> tailwind-merge strips the *whole* class on any sub-property override, which
> would break `Card`'s granular-override contract (`bg-muted/30`, `rounded-lg`,
> …). A class-map keeps per-property `cn()` overrides working, keeps the
> single-source-of-truth + lint chokepoint, and — living in ui-kit — lets the
> shadcn overlays consume it without a layer-inverting cycle. So §2 (`@utility`)
> and §3 (`custom-utilities.ts`) below were **not** needed; everything else
> landed as planned. `DialogContent` was left untouched (it's a centering
> wrapper, panel is consumer-supplied) to avoid breaking existing dialogs.

## Implementation

### 1. New primitive `plugins/primitives/plugins/surface/`

Mirrors `card`'s shape (component **and** lint — unlike the lint-only
`z-layers`/`control-size`):

```
plugins/primitives/plugins/surface/
├── CLAUDE.md                       # prose + autogen reference block
├── package.json                    # { name: "@singularity/plugin-primitives-surface", private, 0.0.1 }
├── web/
│   ├── index.ts                    # barrel: export { Surface, type SurfaceLevel/SurfaceProps }; default PluginDefinition
│   └── internal/
│       └── surface.tsx             # the component
└── lint/
    ├── index.ts                    # default export { name: "surface", rules, ignores }
    └── no-adhoc-surface.ts         # the rule
```

**Component API** (`surface.tsx`):

```tsx
export type SurfaceLevel = "sunken" | "base" | "raised" | "overlay";

export interface SurfaceProps extends ComponentPropsWithoutRef<"div"> {
  level: SurfaceLevel;
  as?: ElementType;        // polymorphic, default "div" (matches Card's pattern)
}
```

- Applies the `surface-{level}` utility class + caller `className` via `cn()`.
- Bakes the Ctrl+A **select-scope** (move `ContentScope`/`selectScopeProps` here
  from `Card` — Surface is now THE generic content-container home). Default-on
  for `sunken/base/raised`; verify it's harmless/desired on `overlay` (dropdown
  menus) — gate off for `overlay` if it traps Ctrl+A unexpectedly.
- `raised`/`overlay` get border+radius+shadow from the utility (contained boxes).
  `base`/`sunken` get background only — full-bleed bands add their own directional
  border (`border-b`) / radius via `className`.

### 2. `@utility` recipes in `ui-kit/web/theme/app.css`

Add alongside the existing `z-*`/`control-*` blocks. Freeze the
`(background, shadow, containment)` bundle per level:

```css
@utility surface-sunken  { background-color: var(--muted); }
@utility surface-base    { background-color: var(--background); }
@utility surface-raised  {
  background-color: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}
@utility surface-overlay {
  background-color: var(--popover);
  border-radius: var(--radius-lg);
  /* ring-1 ring-foreground/10 replicated as an inset ring layered under the drop shadow */
  box-shadow: var(--shadow-md), inset 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent);
}
```

These are global CSS — usable as plain classes anywhere (like `z-overlay`), no
import, **no cross-plugin cycle**. ui-kit consuming `surface-overlay` in its own
shadcn components is fine.

### 3. Register in `ui-kit/web/theme/custom-utilities.ts`

Add `SURFACE_UTILITIES = ["surface-sunken","surface-base","surface-raised",
"surface-overlay"]` and a `CUSTOM_UTILITY_REGISTRY` entry. `surface-raised` sets
4 properties (bg/border/radius/shadow), so register as a synthetic `group:
"surface"` (the four levels mutually conflict — only one at a time) with
`conflictsWith` covering the bg / border / rounded / shadow built-in groups, so a
later explicit `bg-*`/`shadow-*`/`rounded-*` still overrides via `cn()`.
The `app-css-utilities-in-sync` check fails the build if this is missing.

### 4. Refactor `Card` onto Surface — `card/web/internal/card.tsx`

`rounded-md border border-border bg-card p-3` + select-scope →

```tsx
<Surface level="raised" as={as} className={cn("p-card", className)} {...props} />
```

Public `Card` / `CardProps` API unchanged. Padding token (`p-card`) stays on
Card. select-scope now comes from Surface. The `bg-card rounded-md border
shadow` chrome comes from `surface-raised` (Card today has *no* shadow — adding
`shadow-sm` is the intended elevation upgrade; confirm visually).

### 5. Refactor shadcn overlays onto `surface-overlay`

Replace the open-coded `rounded-lg bg-popover ... shadow-md ring-1
ring-foreground/10` chrome with `surface-overlay` (keep `p-*`,
`text-popover-foreground`, animation/positioning classes) in:
- `ui-kit/.../popover.tsx` (`PopoverContent`)
- `ui-kit/.../dropdown-menu.tsx` (`DropdownMenuContent` + sub-content)
- `ui-kit/.../dialog.tsx` (give `DialogContent`'s panel a real overlay surface — currently a gap)

### 6. Lint rule `no-adhoc-surface.ts` (subsumes `no-adhoc-card`)

Copy `collectTokens` + `baseClass` + host-tag gate **verbatim** from
`z-layers/lint/no-adhoc-zindex.ts` / `card/lint/no-adhoc-card.ts`. Two
co-occurrence fingerprints over one `className` attribute's aggregated token set:

- **raised** (identical to today's card rule): `rounded-*` ∧ `border` ∧ `bg-card`
  ∧ padding — keep the `p-card`/`p-row` escape + `{span,div,button,a}` host gate.
  Message → `<Surface level="raised">` / `<Card>`.
- **overlay** (new): `bg-popover` ∧ (`shadow-*` ∨ ring) ∧ `rounded-*`.
  Message → `<Surface level="overlay">` / `PopoverContent`.

`base`/`sunken`: no fingerprint (ambiguous). No auto-fix. Escape hatches: render
through `<Surface>`/`<Card>`/`PopoverContent` (PascalCase host gate skips them),
or `// eslint-disable-next-line surface/no-adhoc-surface -- <reason>`.

**Delete** `plugins/primitives/plugins/card/lint/` (rule + barrel). `Card`'s
sanctioned-home status now comes from being a `<Surface>` wrapper. `build`
regenerates `lint.generated.ts` (drops the card entry, adds surface) — no manual
edit.

### 7. Migrate the sites the new overlay fingerprint will flag

The raised fingerprint is unchanged, so code that passed `no-adhoc-card` still
passes. The **new overlay fingerprint** will flag open-coded overlays — migrate
to `<Surface level="overlay">` (or eslint-disable with reason) or `./equin
check` fails:
- `primitives/command-palette/.../command-palette-dialog.tsx:140`
- `page/plugins/editor/web/components/slash-menu-plugin.tsx:165`
- `page/plugins/inline-page-link/.../inline-page-link-plugin.tsx:221`
- `primitives/multi-select/web/internal/selection-bar.tsx:21`
- `screenshot/plugins/draw-on-app/.../live-draw-overlay.tsx:65`
- `reorder/web/internal/dnd-list-middleware.tsx:570`
- (grep the audit list — ~10 total)

Also `grep -rn "card/no-adhoc-card"` for existing eslint-disable comments and
rename them to `surface/no-adhoc-surface` (the old rule id disappears → unknown-rule errors).

### 8. Docs

- New `surface/CLAUDE.md` (scale table + enforcement section + autogen block).
- Update `card/CLAUDE.md` (now composes Surface).
- Update the `theme` skill's "Design-standard enforcement" list to add Surface.
- `plugins-doc-in-sync` regenerates `plugins-compact.md`/`plugins-details.md` on build.

## Scope boundary

This change lands: the primitive, the 4 `@utility` recipes + registry,
`Card`/overlay refactors, the lint rule (subsuming card), and migration of the
~10 overlay-fingerprint sites. **Out of scope (follow-up sweep):** proactively
converting the ~80 open-coded `base`/`sunken` planes to `<Surface>` — those
aren't hard-linted, so they can migrate incrementally (`add_task` a sweep).

## Critical files

- NEW `plugins/primitives/plugins/surface/{package.json,CLAUDE.md,web/index.ts,web/internal/surface.tsx,lint/index.ts,lint/no-adhoc-surface.ts}`
- `plugins/primitives/plugins/ui-kit/web/theme/app.css` (+4 `@utility`)
- `plugins/primitives/plugins/ui-kit/web/theme/custom-utilities.ts` (+`SURFACE_UTILITIES` + registry)
- `plugins/primitives/plugins/card/web/internal/card.tsx` (compose Surface)
- DELETE `plugins/primitives/plugins/card/lint/{index.ts,no-adhoc-card.ts}`
- `plugins/primitives/plugins/ui-kit/.../{popover,dropdown-menu,dialog}.tsx`
- overlay migration sites (§7)

## Reuse (do not reinvent)

- `collectTokens` + `baseClass` + host-tag gate — copy from
  `z-layers/lint/no-adhoc-zindex.ts` / `card/lint/no-adhoc-card.ts`.
- Lint auto-discovery — just add `lint/index.ts` with a default export; `build`
  regenerates `lint.generated.ts` and registers the rule repo-wide as `error`.
- `@utility` + `custom-utilities.ts` registry pattern — mirror `Z_LAYER_UTILITIES`.
- select-scope (`ContentScope`/`selectScopeProps`) — relocated from `Card`.
- Polymorphic `as` + `cn()` className passthrough — mirror `Card`.

## Verification

1. `./equin build` — must pass `app-css-utilities-in-sync` (surface utils
   registered), `plugins-doc-in-sync`, `type-check`, and `eslint`
   (`no-adhoc-surface` registered; all overlay sites migrated).
2. `./equin check` green.
3. Add a focused lint test (bun:test) next to `no-adhoc-surface.ts`: assert the
   raised + overlay fingerprints flag, and that `<Surface>`/`<Card>`/
   `PopoverContent` + the `p-card` escape do not.
4. Visual no-regression via `bun e2e/screenshot.mjs` on
   `http://<worktree>.localhost:9000`: capture a card/section (raised), a pane
   body (base), a tool-call well (sunken), and the command palette (overlay)
   before/after — confirm Card's new `shadow-sm` and the unified overlay recipe
   look right.
5. **Consistency proof** (the whole point): switch the shadow preset
   `default → elevated` in the theme customizer and confirm every `raised`/
   `overlay` surface lifts together — no surface left flat.
