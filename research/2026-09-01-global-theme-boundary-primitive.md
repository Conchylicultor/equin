# The `<Theme>` boundary primitive

## Context

A theme boundary today is an element carrying `data-theme-scope="app:<id>"`. CSS
blocks emitted by `theme-engine` target that attribute and override the design
tokens for the subtree, so boundaries nest correctly by plain CSS cascade.

But a boundary is **three** coordinated things, and nothing in the codebase owns
all three together:

1. the `data-theme-scope` attribute on the element,
2. a `PortalThemeScopeProvider` with the same token, so popovers/menus that
   portal out of the subtree keep its theme,
3. **painting a canvas** — because custom properties cascade *down* while paint
   does not travel *up*. A boundary that paints nothing is visually inert: an
   ancestor's fill shows through, in the ancestor's theme.

Every site hand-assembles those pieces, and they disagree:

| site | attribute | portal forward | paints |
|---|---|---|---|
| `surface-body.tsx:342` (tab container) | ✓ | ✓ | ✓ via placement `paintClassName` |
| `app-tabs-body.tsx:37` (keep-alive fallback) | ✓ | ✓ | **✗ `absolute inset-0` only** |
| `app-tab-bar.tsx:108` | ✓ | ✓ | ✓ `bg-sidebar` |
| `app-rail.tsx:26` | ✓ | **✗** | ✓ `bg-background` |
| `toaster-host.tsx:37` | ✓ | n/a (is the portal target) | ✗ (deliberate) |
| `collapsed-bar.tsx:23` | ✓ | ✗ | `bg-muted/40` (translucent) |
| `pane-box.tsx:61` | ✓ | ✓ | ✓ `bg-background` |

Every gap is silent. This was found the hard way: `PaneBox` shipped with the
attribute and the portal forward but no paint, so a Pages pane hosted in the
agent manager read Pages' `--background` and painted none of it — the user saw
the host's canvas. `app-tabs-body` still has that exact bug today.

**Goal.** One primitive that owns the whole contract, and replace every
hardcoded usage with it, so a half-built boundary has no spelling.

## Design

### The primitive

New plugin `plugins/primitives/plugins/css/plugins/theme-boundary/` — a sibling
of `ui-kit` under `css/plugins/`, the same shape `surface` and `viewport-overlay`
already have (they import *from* ui-kit; ui-kit never imports them, so no cycle).
Named `theme-boundary` rather than `theme` because `ui/theme-engine`,
`ui/tokens` and `apps-core/theme-scope` already occupy the bare word; the
exported component is `<Theme>`.

```tsx
<Theme name={appThemeScope("pages")} surface="canvas">…</Theme>
```

```ts
interface ThemeProps extends Passthrough {
  /** Scope token (`appThemeScope(id)`). `undefined` = inherit `:root`. */
  name: string | undefined;
  /** REQUIRED. What this boundary paints — omission is not a decision. */
  surface: "canvas" | "chrome" | "sunken" | "none";
  /** Tag or component to render. Default `"div"`; accepts `Stack`, `"button"`, … */
  as?: React.ElementType;
  className?: string;
  children?: React.ReactNode;
}
```

It renders one element carrying `data-theme-scope={name}` plus the paint class,
and wraps `children` in `PortalThemeScopeProvider scope={name}`. Nothing else —
in particular **not** `<Surface>`, which would drag in `tabIndex={-1}` and a
Ctrl+A select-scope onto every pane, rail and tab strip. It reads the same
frozen bundles instead, exactly as ui-kit's own `OverlayPanel` does:

- `canvas` → `SURFACE_LEVELS.base` (`bg-background` + `--chrome-mask` + `--hover-fill`)
- `sunken` → `SURFACE_LEVELS.sunken` (`bg-muted` + the same two helpers)
- `chrome` → `bg-sidebar` — the recessed chrome-frame tone. **Not** in
  `SURFACE_LEVELS`, because `--sidebar` is a separate token group
  (`ui/tokens/sidebar-palette`, 8 tokens, its own preset picker) that a preset
  can retint independently of `--background`. The primitive adds the matching
  `--chrome-mask`/`--hover-fill` for it so the bundle stays complete.
- `none` → paints nothing, *as a declaration*. The toaster host is the one
  honest case: its children are popover-level cards that paint themselves.

Three properties make this hard to get wrong:

- `surface` is **required**, so a new boundary cannot silently paint nothing —
  that is a `tsc` error, rung 2 on the ladder in `CLAUDE.md`.
- `name` accepts `undefined` because `useChromeThemeScope()` legitimately
  returns it ("inherit `:root`"). `PortalForwardProvider` already treats
  `undefined` as a no-op, so the two halves agree by construction.
- `as` borrows `Surface`'s *shape* so a site that is a `<Stack>` or a `<button>`
  today keeps its element rather than gaining a wrapper div — but **not**
  `Surface`'s `display`. Correction to an earlier draft of this doc, which said
  "follows the `Surface` precedent" and, read literally, produces a bug:
  `<Surface>` forces `block` because a surface is a contained *box*. A theme
  boundary is a region of layout that already exists. `Stack` merges a caller's
  `className` last (`cn("flex", …, className)`), so a `block` from `<Theme>`
  would win over Stack's own `flex` and break the flex chain at the tab strip
  and the rail. `<Theme>` therefore emits no display class at all; an
  inline-by-default tag would have to pass its own `block`, and no call site is
  one.

- The `surface` role is the ONLY way to choose a background. Layering a `bg-*`
  through `className` is a trap: tailwind-merge replaces the `bg-` class but
  leaves the role's `--chrome-mask` / `--hover-fill` pointing at the original
  tone, so both silently lie. This is a second, independent reason the collapsed
  bar takes opaque `sunken` rather than keeping `bg-muted/40`.

### Enforcement

New rule `theme-boundary/no-adhoc-theme-scope`, contributed from
`plugins/primitives/plugins/css/plugins/theme-boundary/lint/index.ts`. A plain
`rules` entry (not `classRules` — it reads an attribute, not class tokens): a
`JSXAttribute` visitor keyed on `node.name.name === "data-theme-scope"`, on any
host element, no tag gate — structurally `no-orphan-composite-role`'s
attribute-identity check with `no-adhoc-viewport-overlay`'s any-element scope. A
second message bans importing `PortalThemeScopeProvider` outside the primitive,
so the other half cannot be hand-rolled either.

Path exemption via the barrel's `ignores` (the established pattern), listing
only `plugins/primitives/plugins/css/plugins/theme-boundary/**` — the file that
*is* the implementation. Per-site escape stays the repo convention:
`// eslint-disable-next-line theme-boundary/no-adhoc-theme-scope -- <reason>`.

## Files

**New** — `plugins/primitives/plugins/css/plugins/theme-boundary/`:
`web/index.ts` (barrel), `web/internal/theme.tsx`, `lint/index.ts`,
`lint/no-adhoc-theme-scope.ts`, `package.json`, `CLAUDE.md`.

**Converted** — each drops its raw attribute and its
`PortalThemeScopeProvider`, and gains a `surface`:

| file | becomes |
|---|---|
| `apps-core/plugins/surface/web/components/surface-body.tsx` | `<Theme surface="canvas">`; see placement note below |
| `apps-core/plugins/tab-surface/web/components/app-tabs-body.tsx` | `<Theme surface="canvas">` — **fixes its missing paint** |
| `apps-core/plugins/tab-bar/web/components/app-tab-bar.tsx` | `<Theme as={Stack} surface="chrome">` |
| `apps-core/plugins/app-rail/web/components/app-rail.tsx` | `<Theme as={Stack} surface="canvas">` — **also gains the portal forward it lacks** |
| `shell/plugins/toast/web/components/toaster-host.tsx` | `<Theme surface="none">` |
| `layouts/plugins/miller/web/components/collapsed-bar.tsx` | `<Theme as="button" surface="sunken">` |
| `primitives/plugins/pane/web/components/pane-box.tsx` | `<Theme surface="canvas">` |

**Placement paint.** All three placements paint `bg-background`
(`docked-placement.tsx:23`, `solo-placement.tsx:36`,
`floating-placement.tsx:59`), as does `FALLBACK_PAINT` (`surface-body.tsx:71`).
Once `<Theme surface="canvas">` owns that, drop `bg-background` from all three
`paintClassName`s and delete `FALLBACK_PAINT`; floating keeps its
`rounded-lg border`, which is window-frame geometry, not a paint role. The
`PlacementDef.paintClassName` field then means only "extra frame chrome" — worth
renaming in the same pass.

## Deliberate visual changes

Two sites do not survive conversion pixel-identical. Both are the bug, not
collateral:

- **`app-tabs-body`** starts painting. It is the degraded keep-alive fallback
  and today shows whatever is behind it; that is the same defect this plan
  exists to remove.
- **`collapsed-bar`** goes from `bg-muted/40` to opaque `bg-muted`. A
  translucent tint inside a theme boundary composites over the *host's* canvas,
  which is precisely the half-themed state — a collapsed guest pane's rail
  currently blends Pages' muted over the agent manager's background.

One behavioural change that is not visual: collapsing the tab container's own
`PortalThemeScopeProvider` into `<Theme>` puts the placement's sibling `Chrome`
overlay inside the portal forward, where it used to sit outside it. Nothing it
paints or how it lays out moves — the provider is pure context, and `<Theme>`
replaced the container `<div>` in place rather than adding one — but a popover
opened from floating's titlebar now keeps the app's theme instead of falling
back to the desktop's. That is the gap this primitive exists to close, so it
stays; it is recorded here because it silently widens which subtree gets the
theme forwarded.

Left alone on purpose: the app rail paints `bg-background` while the tab strip
paints `bg-sidebar`, though both are chrome frame. Unifying them is a real
design question about the rail's tone, not a mechanical conversion — file it
separately rather than smuggling a restyle into this change.

## Verification

1. `./equin build` (background) — the new lint rule must report **zero**
   violations, which is the machine-checkable statement of "all hardcoded usages
   replaced". Temporarily reintroducing a raw `data-theme-scope` must fail the
   `eslint` check.

   The rule bans the attribute AND the `PortalThemeScopeProvider` import (keyed
   on the imported name, so an alias cannot dodge it), so before the conversions
   land it reports **11**: 7 attribute sites plus 4 imports (`surface-body:17`,
   `app-tab-bar:7`, `app-tabs-body:3`, `pane-box:6`). ui-kit's own barrel is
   correctly not flagged — its line is an `export … from`, and the barrel must
   keep exporting the symbol for `<Theme>` itself to import.

   `./equin test plugins/primitives/plugins/css/plugins/theme-boundary`
   covers the rule itself (12 cases): the attribute on an intrinsic, a
   capitalized component and a member tag; the aliased import; and — the two
   that matter for false positives — NOT firing on a `[data-theme-scope=…]` CSS
   selector string or a `getAttribute` read, which `theme-engine` and the pane
   e2e script are full of.
2. `./equin run plugins/primitives/plugins/pane/e2e/pane-theme-scope.ts --page <blockId>`
   — the existing 10 assertions must still pass, especially
   *"the pane PAINTS it"* / *"the host's own canvas stays put"*.
3. Extend that script (or add a sibling `theme-boundary/e2e/boundaries.ts`) with
   one generic sweep: for **every** `[data-theme-scope]` element on screen at
   `/agents/page/<id>`, assert its computed `background-color` is not
   `rgba(0, 0, 0, 0)` unless it is the toaster host. That is the whole class of
   bug, asserted once, rather than per-site.
4. Eyeball the four chrome surfaces at `http://<worktree>.localhost:9000` — rail,
   tab strip, a collapsed miller column, and a toast — against `main`, since
   those are the conversions with a paint change.
