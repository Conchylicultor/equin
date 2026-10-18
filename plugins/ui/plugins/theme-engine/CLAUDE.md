# theme-engine

A **theme** is a named set of token values (colors, type, spacing, shape,
shadows, fonts) across the token groups in `plugins/ui/plugins/tokens`. This
plugin decides which theme each part of the screen shows, and paints it.

## One theme per scope

A scope is the desktop or one app. Each scope stores ONE choice: which theme
paints it (`themeSelectionConfig`). The desktop's choice is the base document;
an app's is its own `config/ui/theme-engine/@app/<id>/theme.jsonc`. The same
document holds `colorMode`, which is still one global setting.

An app without its own document shows the desktop's theme, whole. Nothing is
stored per token group, so an app cannot own part of a look and inherit the
rest. "Customize for <App>" in the customizer gives an app its own document; a
committed `theme.jsonc` does it in git (the website's: `{ "theme": "equin" }`).

## Where themes come from

- **Code themes**: `defineTheme(…)`, contributed through `ThemeEngine.Theme`.
  Default (names no group) is contributed here; the website contributes `equin`.
- **Theme sources** (`ThemeEngine.ThemeSource`; theme-engine names none):
  - `resident`: themes that can be painted now. `saved-themes` is the only one:
    tweakcn imports and custom themes, hydrated before the first paint.
  - `browse`: a catalog (tweakcn's community themes). An entry becomes a theme
    once its `adopt` saves it into a resident source.

Each source's hook (`useThemes` / `useEntries`) returns a `ResourceResult`
(`useEndpointResource` for an endpoint-backed one), so a failed read is its own
state, never a forever-loading or empty list.

`useThemes()` = code themes + every resident source, pending while any resident
source loads. A resident source whose read FAILED never holds it pending — the
app would blank: its last-known themes (`stale`) still count, and it is listed
in `failures`, which the gallery renders with Retry. A selection absent while a
source failed paints Default without being reported `missing` (whether it
exists is unknown). The gallery's browse listings follow the same rule. A code theme's id is a bare word and a stored one's is
`<source>:<key>`, so they cannot collide; a duplicate id throws.

## How a theme resolves (`core/resolve-theme.ts`)

Every registered group starts at its schema defaults (`darkDefault` in dark
mode). The theme's `extends` chain is then applied from the root down, so the
theme's own values win; an empty value never blanks an inherited one. The color
adjustment is the nearest one set along the chain. A group the chain never
mentions keeps its schema defaults — never another scope's choice — so a
partial theme is safe. A cycle or a missing `extends` target throws; the write
path refuses both, so a throw is a bug.

## Editing makes a copy

Code themes and tweakcn imports are read-only. The first edit a scope makes on
one of them creates "<name> copy" (a custom theme that `extends` it) and selects
it for that scope; later edits change the copy. Every editor goes through
saved-themes' `useEditTheme`.

## A missing theme is never silent

A scope whose selected theme does not exist paints Default, files a
`missing-theme` report (`themeResolutionReportSink`), and the theme picker says
so. Only a hand-edited file gets there: deleting a theme first moves every scope
selecting it to Default. Stored values the resolver drops (a retired group or
token) are reported the same way.

## Sub-themes: a region that wears a few values on top

A **sub-theme** (`defineSubTheme`, contributed through `ThemeEngine.SubTheme`)
is a handful of token values one region of the screen wears over whatever
theme surrounds it. The website is the case: the app's theme (`equin`) is its
palette and font at standard UI sizes, and every page wears the
`equin-document` sub-theme, which only sets the page's type scale, spacing and
radius.

```tsx
<Theme name={subThemeScope(equinDocumentTheme)} surface="canvas">…</Theme>
```

It differs from a theme in three ways:

- **Silence means "the surrounding theme", not "the schema default".**
  `SubThemeStyles` paints each fragment as a block holding ONLY the tokens it
  names, on `[data-theme-scope="sub:<id>"]`; everything else reaches the region
  by plain CSS inheritance. So a sizes-only sub-theme keeps the app's colours,
  even after the app's theme is switched. Its values are painted as written —
  the surrounding color adjustment does not apply to them.
- **What derives from a token it names follows it.** A derived default
  (`chromePanePadStart: var(--chrome-pad-x)`) is computed where it is declared
  and inherited computed, so re-valuing only the base would not reach it. The
  block therefore also re-declares every token of the same group whose default
  reads a named one, transitively (`subThemeBlockValues`). Inside the region,
  that token is its default over the sub-theme's value, even where the
  surrounding theme gave it a value of its own. To keep a different value, the
  sub-theme names it. Derivations that cross groups are not followed.
- **It is never selected.** No scope picks it, the theme picker never lists it;
  a region opts in by wrapping itself in `<Theme>`.
- **Popups leave it.** The boundary forwards its token as region-only
  (`PortalForwardProvider regionOnly`, see ui-kit): a popover, menu, dialog or
  tooltip opened from inside wears the surrounding theme, while content that is
  portaled but still part of the region (an adaptive bar's items) keeps it.

Each fragment must name the same tokens in light and dark (`both(…)` does it):
the light block also matches in dark mode, so a light-only token would leak.
Sub-themes are painted for as long as they are contributed, not when a region
mounts, so they are in the pre-paint cache and a region never repaints.

## Fixed themes: a region that always wears one whole theme

A **fixed theme** (`defineFixedTheme`, contributed through
`ThemeEngine.FixedTheme`) is a whole theme one region always wears, whatever
its scope selects. The app chrome is the case (`apps-core/chrome-theme`): the
rail, tab bar, action bar and toasts stay graphite while the focused app —
and its theme — changes underneath them.

```tsx
<Theme name={fixedThemeScope(chromeTheme)} surface="chrome">…</Theme>
```

- **Resolved like a theme, worn like a sub-theme.** It resolves over every
  group's schema defaults, so nothing from the surrounding app's theme leaks in;
  but no scope selects it and the picker never lists it.
- **One scheme in both modes.** `scheme: "dark"` paints the dark half of the
  resolution under both the light and the dark selector — the frame does not
  flip with the light/dark switch. Tailwind `dark:` variants inside still follow
  the global class (per-scope color mode is deferred).
- **Popups keep it** — the forward is not region-only: a menu opened from the
  chrome is more of the chrome.
- Painted for as long as it is contributed and never pending, so it is in the
  pre-paint cache.

## Painting

`ThemeInjector` paints the focused full-surface app's theme into `:root` (the
desktop's when nothing is focused or the focus is a floating window).
`AppScopeThemes` adds a `[data-theme-scope="app:<id>"]` block for each other
visible app with its own theme document, `SubThemeStyles` one sparse
`[data-theme-scope="sub:<id>"]` block per sub-theme fragment, and
`FixedThemeStyles` a complete `[data-theme-scope="fixed:<id>"]` block per
fixed theme. Nothing is
injected while a resident
source loads, so the CSS replayed before first paint stays up (pre-paint cache:
`.claude/skills/theme/SKILL.md`). Picking a theme is `theme-gallery`'s job.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Paints each scope's selected theme: the token-group, theme and theme-source slots, the theme selection config, and the injector that resolves one theme per scope into CSS variables.
- Web:
  - Slots:
    - `ThemeEngine.VariantGroup`
    - `ThemeEngine.TokenGroup`
    - `ThemeEngine.Theme`
    - `ThemeEngine.SubTheme`
    - `ThemeEngine.FixedTheme`
    - `ThemeEngine.ThemeSource`
  - Slot contributors: 38 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `ThemeEngine.TokenGroup` ×16
    - `ThemeEngine.Theme` ×9
    - `ThemeEngine.VariantGroup` ×6
    - `ThemeEngine.SubTheme` ×4
    - `ThemeEngine.ThemeSource` ×2
    - `ThemeEngine.FixedTheme` ← `apps-core.chrome-theme`
  - Contributes:
    - `Core.Root` → `ThemeInjector`
    - `Core.Root` → `AppScopeThemes`
    - `Core.Root` → `SubThemeStyles`
    - `Core.Root` → `FixedThemeStyles`
    - `Core.Root` → `ThemeSelectionsCollector`
    - `ConfigV2.WebRegister` "theme"
    - `DynamicEnum.Options` "Theme"
    - `ThemeEngine.Theme` "Default"
  - Uses:
    - `apps-core.Apps`
    - `apps-core.useActiveApp`
    - `apps-core/theme-scope.useRootThemeScope`
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `config_v2.useConfigResult`
    - `config_v2.useScopeMembership`
    - `config_v2.useSetConfig`
    - `fields/dynamic-enum/config.DynamicEnum`
    - `primitives/css/ui-kit.appThemeScope`
    - `primitives/css/ui-kit.fixedThemeScope`
    - `primitives/css/ui-kit.subThemeScope`
    - `primitives/css/ui-kit.themeScopeSelectors`
    - `primitives/live-state.foldResource`
    - `primitives/slot-render.defineRenderSlot`
  - Exports (types):
    - `ColorMode`
    - `ConfiguredColorMode`
    - `ResolvedThemeState`
    - `ThemeResolutionFault`
    - `ThemeSelection`
    - `ThemeSelectionsState`
    - `ThemeSourceContribution`
    - `ThemeSourceEntry`
    - `ThemeSourceFailure`
    - `ThemesState`
    - `TokenGroupContribution`
    - `VariantGroupContribution`
  - Exports (values):
    - `ScopedAppTheme`
    - `ThemeEngine`
    - `themeResolutionReportSink`
    - `ThemeScope`
    - `ThemeScopeProvider`
    - `transformValues`
    - `useColorMode`
    - `useResolvedColorMode`
    - `useResolvedTheme`
    - `useSetColorMode`
    - `useThemes`
    - `useThemeScopeId`
    - `useThemeSelections`
    - `whenNoScopeSelects`
- Server:
  - Contributes: `ConfigV2.Register` "theme"
  - Uses: `config_v2.ConfigV2`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/dynamic-enum/config.dynamicEnumField`
    - `fields/enum/config.enumField`
  - Exports (types):
    - `ColorAdjustment`
    - `FixedTheme`
    - `GroupValues`
    - `ResolvedTheme`
    - `SkippedThemeValue`
    - `SubTheme`
    - `Theme`
    - `ThemeId`
    - `ThemeResolution`
    - `ThemeSource`
    - `TokenGroupDescriptor`
    - `TokenGroupField`
    - `TokenGroupFragment`
    - `TokenGroupSchema`
    - `TokenValues`
  - Exports (values):
    - `both`
    - `ColorAdjustmentSchema`
    - `DEFAULT_THEME_ID`
    - `defineFixedTheme`
    - `defineSubTheme`
    - `defineTheme`
    - `defineTokenGroup`
    - `isBuiltInThemeId`
    - `lightOnly`
    - `mergeGroupValues`
    - `NEUTRAL_COLOR_ADJUSTMENT`
    - `resolveFixedTheme`
    - `resolveTheme`
    - `subThemeBlockValues`
    - `themeSelectionConfig`
    - `TokenGroupFragmentSchema`
    - `TokenGroupFragmentsSchema`
    - `tokenGroupMatchesSearch`
    - `tokenVarName`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
  - Imported by: 40 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui` ×26
    - `apps` ×11
    - `apps-core/chrome-theme`
    - `plugin-meta/token-usage`
    - `reports/theme-resolution`
- Sub-plugins:
  - **`quick-theme`** — Quick-switch theme popover on the global action bar: contributed quick sections (the theme picker, the light/dark switch), every component variant picker, and a hand-off to the full customizer pane…
  - **`saved-themes`** — Saved themes (tweakcn imports and custom themes) as a resident theme source, hydrated before first paint, plus useEditTheme — the one place theme edits land, copying a read-only theme into a custom…
  - **`theme-customizer`** — Extensible theme customization pane: per-app theme toggle, component variant pickers, search, and contributed sections, plus the token-group editor kit (useTokenGroupEditor, TokenRows, FillFromMenu)…
  - **`theme-gallery`** — The Theme DataView: every selectable theme plus every catalog's unsaved entries, with My themes / Community / Curated views. Picking one selects it for the current scope (saving a catalog entry…

<!-- AUTOGENERATED:END -->
