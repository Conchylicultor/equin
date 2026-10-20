# theme-boundary

The sanctioned home for a **theme boundary** — the element that says "everything
below here wears theme X". `<Theme name surface>` owns the whole contract:
the `data-theme-scope` attribute, the portal forward that carries it to popovers
opened from the subtree, and the canvas it paints.

Named `theme-boundary` rather than `theme` because `ui/theme-engine`,
`ui/tokens` and `apps-core/theme-scope` already occupy the bare word; the
exported component is `<Theme>`.

## Why this primitive exists

A boundary is **three** coordinated things, and until this plugin nothing owned
all three together:

1. **`data-theme-scope` on the element.** `theme-engine` emits CSS blocks
   selected on `[data-theme-scope="app:<id>"]`, which override the design tokens
   for the subtree. Boundaries nest correctly by plain CSS cascade.
2. **A `PortalThemeScopeProvider` carrying the same token.** A popover or menu
   opened from inside the subtree portals out of it, and re-stamps the attribute
   on the way so it keeps the theme it was opened from.
3. **A painted canvas.** Custom properties cascade *down*; paint does not travel
   *up*. A boundary that paints nothing is visually inert — the ancestor's fill
   shows through, in the ancestor's theme, under text that reads the new one.

Every site used to hand-assemble those pieces, and they disagreed. `PaneBox`
shipped with (1) and (2) and no paint, so a Pages pane hosted in the agent
manager read Pages' `--background` and painted none of it — the user saw the
host's canvas. The app rail had (1) and (3) and no portal forward, so a menu
opened from it came back wearing the desktop theme. `app-tabs-body` carried the
attribute over an `absolute inset-0` box that painted nothing at all.

Every one of those gaps is silent. Nothing throws, nothing fails to type, and it
only shows up as a wrong-looking screenshot — which is why the fix is a
primitive with a **required** `surface`, not a note in a doc.

## API

```tsx
<Theme name={appThemeScope("pages")} surface="canvas">{children}</Theme>
<Theme as={Stack} name={themeScope} surface="chrome" direction="row">…</Theme>
```

- **`name`** — the scope token, from `appThemeScope(id)` / `paneThemeScope(pane)`,
  or `subThemeScope(subTheme)` for a theme-engine sub-theme. A sub-theme token
  is forwarded **region-only**: popups opened from inside wear the enclosing
  theme (the sub-theme restyles a page, not the menus opened from it), while an
  adaptive bar's portaled items keep it. `fixedThemeScope(fixedTheme)` names a
  fixed theme (the app chrome's): a whole theme, forwarded normally, so popups
  opened from inside keep it.
  `undefined` is a legitimate value meaning *inherit the enclosing theme*. Both
  halves agree on it by construction: no attribute is stamped, and
  `PortalForwardProvider` already treats an undefined value as a no-op.
- **`surface`** — **required**. What this boundary paints. Omission is not a
  decision, so there is no default; a new boundary that paints nothing is a
  `tsc` error rather than a screenshot bug.
- **`as`** — the tag or component to render. Default `"div"`; a site that is a
  `<Stack>` or a `<button>` keeps its element instead of gaining a wrapper div
  that would break its flex chain.
- **`className`**, `ref`, and every unnamed prop land on that one element — see
  [the passthrough contract](../../../passthrough/CLAUDE.md). `data-theme-scope`
  and the paint class are applied *after* the spread: they are what the
  primitive **is**, and a spread scope token would retarget the boundary to a
  theme its paint and its portal forward do not agree with.

### The app scope, for settings read in JS

An `app:<id>` boundary also publishes its token as React context
(`useEnclosingAppThemeScope`); fixed and sub-theme boundaries leave it alone.
Some theme settings are not CSS tokens — which variant a region renders, the
progress-bar style — and are read in JS from the app's `app:<id>` config scope.
Reading them from the nearest app boundary (via `apps-core/theme-scope`'s
`useAppSettingsScope`) makes them follow the same region the colours do: a pane
wears its home app's settings in whichever app hosts it.

### `<PopupTheme name>`: only the popups

`<PopupTheme name={…}>` themes the popups opened from inside it — popovers,
menus, tooltips, dialogs — and nothing else: no element, no paint, the region
keeps the theme around it. The inverse of a sub-theme, whose token reaches the
region but not its popups. The case is a control that lives in an app but
opens part of the frame: the app launcher's button sits in the app's header (app
theme) and its grid is the chrome (`apps-core/app-launcher`). The popup's icons
follow it — `OverlayPanel` draws its icons in the scope its portal re-stamps.

### The four surfaces

| `surface` | paints | for |
| --- | --- | --- |
| `canvas` | `SURFACE_LEVELS.base` (`bg-background` + the two helpers) | pane / page / tab canvas — the ground plane |
| `chrome` | `bg-sidebar` + `[--chrome-mask:var(--sidebar)]` + `[--hover-fill:var(--sidebar-accent)]` | the chrome frame: tab strip, sidebar tone |
| `sunken` | `SURFACE_LEVELS.sunken` (`bg-muted` + the two helpers) | a recessed well — a collapsed rail, a band below the base plane |
| `none` | nothing, **as a declaration** | a portal host whose children are overlay-level cards that paint themselves (the toaster) |

`canvas` and `sunken` read `SURFACE_LEVELS` rather than re-spelling it, so a
boundary and a `<Surface>` of the same role re-theme together on a preset swap.

`chrome` cannot: `--sidebar` is its own token group
(`ui/tokens/sidebar-palette`, 8 tokens with its own preset picker) that a preset
retints independently of `--background`, so it is authored in this plugin as the
complete bundle in the same shape — background plus the two helper vars the
background implies. `--chrome-mask` is *my background, for something painting
over me* (a sticky bar inside the boundary masks with it); `--hover-fill` is *a
visible step off my background, for something highlighting inside me* (a ghost
`Button` hovers to it). A background published without them is a background that
lies: a ghost control on the sidebar tone would hover to the page canvas's
`--muted`, which sits on top of `--sidebar` and reads as no hover at all.

## Two deliberate departures from `<Surface>`

**It does not compose `<Surface>`.** It reads the same frozen `SURFACE_LEVELS`
bundles, the way ui-kit's own `OverlayPanel` does, but `<Surface>` bakes in
`tabIndex={-1}` and a Ctrl+A select-scope — right for a contained card, wrong to
apply to every pane, rail and tab strip in the app.

**It does not own `display`.** `<Surface>` emits `block` ahead of everything
else, because a surface is a contained *box* and `as` must stay purely a choice
of tag. A theme boundary is the opposite: it is a **region of layout that
already exists**, and its sites are a flex `Stack` tab strip, a rail, a pane box.
A forced `block` would win over the component's own `flex` — a `className`
handed to `<Stack>` is merged *after* Stack's own classes, so tailwind-merge
resolves in the boundary's favour — and break the flex chain. The boundary
paints and scopes; it does not decide what kind of box it is. A site that renders
an inline-by-default tag passes its own `block`.

## Never tune the background through `className`

`surface` is the only way to pick a background — nothing lints this, so it is on
you. `cn("bg-background [--chrome-mask:var(--background)]", "bg-muted/40")` →
`"[--chrome-mask:var(--background)] bg-muted/40"`: tailwind-merge drops the
losing `bg-*`, but the helper vars have nothing to conflict with and survive
pointing at the tone that just left. The surface then lies about itself — a
sticky bar masks with the wrong colour, a ghost control hovers to a step off a
background that isn't there — silently, and only under some presets.

Consuming what a role publishes is the point, though: `hover:bg-hover-fill` reads
the var `sunken` sets, so the hover follows the boundary's own theme.

Need a background no role offers? That is a question about the role set.

## Enforcement

`lint/no-adhoc-theme-scope.ts` fails `./singularity check` on the two
hand-writable halves of the contract:

- a raw **`data-theme-scope` JSX attribute**, on any host element. No tag gate —
  the attribute's identity is the whole fingerprint (structurally the check
  `aria-safety/no-orphan-composite-role` makes on `role=`), and a tag allowlist
  fails open, which is why `no-adhoc-surface` and `no-adhoc-viewport-overlay`
  both deleted theirs.
- an import of **`PortalThemeScopeProvider`**, keyed on the imported *name*
  rather than the module path, so a deep path or a re-export cannot fail open.
  Reading the forwarded scope (`usePortalThemeScope`) is a read, not a boundary
  declaration, and is left alone.

There is no autofix. Choosing which of the four roles a site paints is exactly
the judgement the primitive exists to force — and two of the pre-existing sites
had it wrong, so copying their paint forward would not have been a safe
transform.

The exemption manifests names **one** glob: this plugin's own
tree, which *is* the implementation both messages redirect to. Never add a
second. A genuinely bespoke boundary escapes per-site, with its reason next to
the code:

```
// eslint-disable-next-line theme-boundary/no-adhoc-theme-scope -- <reason>
```

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Theme-boundary primitive: <Theme name surface> is the one element that says 'everything below here wears theme X', complete — the data-theme-scope attribute, the PortalThemeScopeProvider that carries it across portals, and the canvas it paints, which no site can now forget because `surface` is required. And <PopupTheme name>: the popups opened from a region wear theme X while the region keeps its own. Plus the no-adhoc-theme-scope lint rule that keeps the three halves from being hand-assembled apart again.
- Web:
  - Uses:
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.PortalThemeScopeProvider`
    - `primitives/css/ui-kit.SURFACE_LEVELS`
    - `ui/icons.IconScopeProvider`
  - Exports (types):
    - `PopupThemeProps`
    - `ThemeProps`
    - `ThemeSurface`
  - Exports (values):
    - `PopupTheme`
    - `Theme`
    - `useEnclosingAppThemeScope`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/sidebar-palette --sidebar`
    - `ui/tokens/sidebar-palette --sidebar-accent`
  - Imported by:
    - `apps-core/app-embed`
    - `apps-core/app-launcher`
    - `apps-core/app-rail`
    - `apps-core/surface`
    - `apps-core/tab-bar`
    - `apps-core/tab-surface`
    - `apps-core/theme-scope`
    - `apps/desktop/windows`
    - `apps/file-explorer/browser`
    - `apps/prototypes/compare/exhibit`
    - `apps/website/pages/apps`
    - `apps/website/shell`
    - `layouts/miller`
    - `plugin-meta/exhibits`
    - `primitives/pane`
    - `shell/global-action-bar`
    - `shell/toast`
- Exemptions:
  - Exempts itself from: `theme-boundary/no-adhoc-theme-scope` — `.` (sanctioned)
  - Exempted by: `primitives/css/theme-boundary` (0 debt)

<!-- AUTOGENERATED:END -->
