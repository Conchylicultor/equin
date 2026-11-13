# theme-engine

A **theme** is a named set of token values (colors, type, spacing, shape,
shadows, fonts) across the token groups in `plugins/ui/plugins/tokens`. This
plugin decides which theme each part of the screen shows, and paints it.

## One theme per scope

A scope is the desktop or one app. Each scope stores ONE choice: which theme
paints it (`themeSelectionConfig`). The desktop's choice is the base document;
an app's is its own `config/ui/theme-engine/@app/<id>/theme.jsonc`. The base
document also holds the GLOBAL `colorMode`; an app's light/dark is its own
(below), and a `colorMode` in an app's theme document is never read.

## Light/dark: one scheme per region

Every app wears its OWN scheme, on its own boundary — whichever app is
focused, in every surface mode. A **scheme carrier** is an element stamped
`data-color-scheme="light|dark"` (ui-kit core's `theme-scope.ts`):

- `<html>` carries the desktop's — the global setting, never an app's;
- every app's `<Theme name="app:<id>">` boundary (tab containers, a pane's
  `PaneBox`) carries its app's effective scheme;
- every fixed theme's boundary carries the fixed theme's `scheme`;
- a popup is re-stamped with the scheme of the region it opened from (the
  portal forward), a `<ColorSchemeRegion scheme>` forces one (the image viewer).

An element wears its NEAREST carrier's scheme, self included: `color-scheme`
by inheritance; the token blocks' dark halves and Tailwind's `dark:` variant
inside `@scope ([data-color-scheme="dark"]) to ([data-color-scheme="light"])`
(ui-kit core's `DARK_SCHEME_SCOPE`: a dark carrier is the scope root, a light one
its limit — at any nesting depth, with no negated selector). Every carrier also re-declares
the desktop's base tokens in its scheme (`ROOT_SCHEME_SELECTORS`), so an app
without a theme of its own wears the desktop's theme in its own scheme. Because
no focus or surface-mode change alters any region's scheme, neither restyles
anything for light/dark: only the canvas (below) follows the focused app.

`ColorSchemePublisher` (a root host of every scope) publishes each scope's
scheme into theme-boundary's store — which the boundaries read and stamp — and,
on the page, puts the desktop's on `<html>`. What a scope wears is
`effectiveColorMode` (`core/config.ts`), the one resolution both runtimes call:

1. the user's per-app override, `appColorModeConfig` (`color-mode`, its own
   descriptor so a scheme never forks the app's theme) at `app:<id>` —
   `default` (the base document's value) means "no override";
2. else the app's declared default, `defineApp({ colorMode })`
   (`global` | `system` | `light` | `dark`, omitted = `global`);
3. `global` = the base document's `colorMode` (dark by default).

`system` follows `prefers-color-scheme` live. Readers: `useColorMode()` — the
scheme of the REGION a component renders in (theme-boundary's
`useColorScheme`), for prop-themed widgets (sonner, charts, code highlighting);
`useColorModeSetting` — the setting the light/dark controls show and write: the
focused full-surface app's (its override), else the global one, with what it
resolves to now; a state, `{ known: false }` until the surface says which app
fills it, so no control shows or writes the desktop's setting meanwhile;
`useColorModeSettingFor(appId)` (a named app — the customizer). Other writers:
`useSetAppColorMode(appId)`, `useSetGlobalColorMode`. The customizer previews a
mode with `usePreviewColorScheme(appId, mode)` — the scope wears it while
mounted, the setting untouched. The controls are `ui/theme-toggle`'s
(quick-theme switches, the customizer's Color mode section). Plain CSS that
differs by scheme uses `light-dark()`, which resolves against the nearest
`color-scheme`; there is no `.dark` class anywhere.

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
    once its adopt (`useAdopt()`, bound to the subtree's transport) saves it
    into a resident source.

Each source's hook (`useThemes` / `useEntries`) returns a `ResourceResult`
(`useLive` over the source's live value), so a failed read is its own
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

It is also how ONE instance of a token-driven primitive looks different without
retheming its app or overriding a className: Home's New app screen wraps its
single `ComposerField` in `newAppPromptTheme` (`apps/home/new-app`), which sets
only `radiusCard`, `padComposerText`, `padComposerActions` and the `composer`
fill (`var(--card)`, so it still follows Home's palette); every other card and
composer in Home keeps the standard box.

Declaring it is not enough — it must also be contributed through
`ThemeEngine.SubTheme`, or the region carries its scope attribute but nothing
is painted for it. The `theme-engine:sub-themes-contributed` check fails on a
`defineSubTheme` no contribution registers.

It differs from a theme in three ways:

- **Silence means "the surrounding theme", not "the schema default".**
  `SubThemeStyles` paints each fragment as a block holding ONLY the tokens it
  names, on `[data-theme-scope="sub:<id>"]`; everything else reaches the region
  by plain CSS inheritance. So a sizes-only sub-theme keeps the app's colours,
  even after the app's theme is switched. Its values are painted as written —
  the surrounding color adjustment does not apply to them.
- **What derives from a token it names follows it.** A derived default
  (`chromePaneCardPadStart: var(--chrome-pad-x)`) is computed where it is declared
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
mounts — in the browser's first commit (they are code, never pending), so a
region never repaints. The server's first-frame head does not carry them.

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
- Painted for as long as it is contributed and never pending, so the browser
  paints it in its first commit; the server's first-frame head does not carry it.

## Painting

**`:root` wears ONE stable theme — the desktop's — and never follows
navigation or the surface mode.** A change of inherited custom properties at
the root restyles the whole document (~18k elements, ~670 inherited custom
properties each: 350–480 ms per change in Chromium), which is what switching
the surface between the desktop and full screen used to pay when `:root` was
re-rooted on the focused full-surface app. Only an edit of the desktop's theme
rewrites `:root`.

- `ThemeInjector` paints the desktop's theme on `:root` and every scheme
  carrier, light and dark halves (`ROOT_SCHEME_SELECTORS`, zero specificity, so
  an app's own blocks on the same element win).
- `AppScopeThemes` paints a `[data-theme-scope="app:<id>"]` block for EVERY app
  with its own theme document — focused or not, visible or not, in every
  surface mode. Every tab container is a `<Theme name="app:<id>"
  surface="canvas">` (`apps-core/surface`), which also forwards the scope to
  popups portaled out of it, so an app looks the same docked, solo or in a
  desktop window, and a focus or mode change writes no token block. An app
  without its own document wears the desktop's base blocks, re-declared on its
  boundary in its own scheme.
- `SubThemeStyles` paints one sparse `[data-theme-scope="sub:<id>"]` block per
  sub-theme fragment, `FixedThemeStyles` a complete
  `[data-theme-scope="fixed:<id>"]` block per fixed theme.
- **The document canvas** (`DocumentCanvas`, `CANVAS_STYLE_ID`) is `<body>`'s
  background, in the focused full-surface app's `--background` and scheme (the
  desktop's when no single app fills the surface; the scheme is baked into the
  block, `system` as a `prefers-color-scheme` query, since `<html>` carries the
  desktop's) — what shows before the app mounts,
  so a page load never flashes the desktop's canvas under a themed app. One
  non-inherited property on one element, so following the focused app restyles
  `<body>` alone. It is held (adopting the server's element, writing nothing)
  until the surface has registered its placements (`useRootThemeScopeState` →
  `{ known: false }`).

So what sits outside every app boundary — `<body>`, a Core.Root overlay
portaled with no forwarded scope — wears the desktop's theme. A surface that
should wear an app's theme is inside that app's `<Theme>` boundary, or opened
from inside it (the portal forward).

Nothing is injected while a resident source loads, so the CSS the server
painted into the HTML stays up (`:root`, the canvas and the opened app's
scope — see below). A painted element is adopted by id and only
removed when its painter unmounts — never as part of a content update.

### Inside a plugin scope

The four painters are root hosts of every scope (`scope: "each"`, web-sdk's
`RootScope`): each `<PluginScope>` (the demo) mounts its own, reading the
scope's token groups, apps, sub/fixed themes and config. Every theme-scope
token stamped inside a scope is qualified by the scope's id
(`qualifyThemeScope`: `<scope>/app:sonata`), by `<Theme>` and the portal
forward alike, so a block the page paints never matches there and the scope's
never matches the page. Inside a scope the painters never touch `:root` or
`<html>`'s scheme: `ThemeInjector` paints the scope's base theme on its root
boundary (`PLUGIN_SCOPE_ROOT_THEME`, drawn by `DemoScope`), complete over
every group the scope registers, and `AppScopeThemes` paints a complete block
for EVERY scope app (its own theme, else the base) — a popup portaled out of
the scope's DOM re-stamps only its app's token. The scope's own
`ColorSchemePublisher` publishes the scope's schemes (its root boundary wears
the scope's global setting).

Picking a theme is `theme-gallery`'s job.

## The first frame is painted by the server

Every block above is rendered by ONE set of functions in `core/paint.ts`, which
`ThemeInjector` and the server both call. The server (`server/internal/`)
renders, per app path, the few elements a page needs before the browser's
painter runs (below) and hands
them to `shell/document-head`, which writes them where the gateway splices them
into `index.html` — so the first frame is themed with no browser storage, and
the browser adopts the elements by id. What the server reads:

- token groups and code themes from
  `theme-declarations.generated.ts`, generated at build from this plugin's web
  slots (`theme-declarations-in-sync`) — the server cannot see web slots;
- the apps' base paths from `declaredApps` (`apps-core/server`, generated the
  same way from `Apps.App`);
- stored themes from the server `ThemeEngine.Source` contribution (saved-themes);
- the selections, the global `colorMode` and each app's override from config,
  resolved with each app's declared default (`declaredApps`) by
  `effectiveColorMode`.

It re-renders on any config-dir change and on each source's change signal.

**The head carries what the page shows before the browser's painter runs, and
what stays up while it is held — not every block the browser paints.** Before
React's first commit the body is empty, so only the canvas is on screen. In
that first commit `ThemeInjector` and its siblings paint every block, in
insertion effects (before any layout or paint), from inputs the boot snapshot
hydrated (selections, saved themes — `boot-and-keep`) or from code (sub-themes,
fixed themes). So an entry holds:

- `:root` in the desktop's theme (every entry);
- the canvas, in the theme and scheme of the app a page load opens there;
- that app's own scoped blocks when it has a theme document — what it wears if
  its theme is still pending at the first commit (a resident theme source not
  hydrated while the selections are: the painter then leaves the served CSS
  up; another visible app wears `:root` until the source arrives). A boot
  snapshot that failed whole leaves app membership unknown, so no app block is
  claimed and the prune drops them. The `""` entry holds the themed
  surface-mode apps' (the desktop's);
- the script putting the desktop's scheme on `<html>` (`system` as a
  `matchMedia` test).

Every other app's blocks, and the sub-themes' and fixed themes', are the
browser's alone (the head once carried them all: ~850 KB of CSS on every page
load). A tab app gets an entry at its base path when it has its own theme
document OR its effective scheme is not the global one; every other path is
the `""` entry.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Paints each scope's selected theme: the token-group, theme and theme-source slots, the theme selection config, the injector that resolves one theme per scope into CSS variables, and light/dark per region: every app wears its own effective color mode (the app's declared default from defineApp, the user's per-app override, else the global setting) on its own boundary, published for theme-boundary to stamp (ColorSchemePublisher), each fixed theme its own scheme, and <html> the desktop's — so a focus or surface-mode change flips no scheme. The light/dark controls read and write the focused full-surface app's setting through useColorModeSetting (a state: not known until the surface says which app fills it); useColorMode is the scheme of the region a component renders in. :root always wears the desktop's theme; each app's theme is painted on its own scope. Registers the theme selection and per-app color-mode configs, and paints the first frame: renders the page's first-frame theme CSS (:root, the canvas and the opened app's scope) into the SPA shell's head (DocumentHead.Fragment) from the generated theme declarations, the ThemeEngine.Source themes, the selections and each app's effective light/dark (its declared default and the user's override), re-rendered when any of them changes.
- Web:
  - Slots:
    - `ThemeEngine.VariantGroup`
    - `ThemeEngine.TokenGroup`
    - `ThemeEngine.Theme`
    - `ThemeEngine.SubTheme`
    - `ThemeEngine.FixedTheme`
    - `ThemeEngine.ThemeSource`
  - Slot contributors: 53 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `ThemeEngine.TokenGroup` ×19
    - `ThemeEngine.Theme` ×14
    - `ThemeEngine.SubTheme` ×8
    - `ThemeEngine.VariantGroup` ×6
    - `ThemeEngine.FixedTheme` ×4
    - `ThemeEngine.ThemeSource` ×2
  - Contributes:
    - `Core.Root` → `ColorSchemePublisher`
    - `Core.Root` → `ThemeInjector`
    - `Core.Root` → `AppScopeThemes`
    - `Core.Root` → `SubThemeStyles`
    - `Core.Root` → `FixedThemeStyles`
    - `Core.Root` → `ThemeSelectionsCollector`
    - `ConfigV2.WebRegister` "color-mode"
    - `ConfigV2.WebRegister` "theme"
    - `DynamicEnum.Options` "Theme"
    - `ThemeEngine.Theme` "Default"
  - Uses:
    - `apps-core.Apps`
    - `apps-core/theme-scope.RootThemeScopeState`
    - `apps-core/theme-scope.useRootThemeScopeState`
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `config_v2.useConfigResult`
    - `config_v2.useScopeMembership`
    - `config_v2.useSetConfig`
    - `fields/dynamic-enum/config.DynamicEnum`
    - `network/live/live-state.foldResource`
    - `primitives/css/theme-boundary.useColorScheme`
    - `primitives/css/theme-boundary.usePublishColorScheme`
    - `primitives/dom/render-mode.useMediaQuery`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/slot-render.defineRenderSlot`
  - Exports (types):
    - `ColorMode`
    - `ColorModeSetting`
    - `ConfiguredColorMode`
    - `ResolvedThemeState`
    - `RootColorModeSetting`
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
    - `useColorMode`
    - `useColorModeSetting`
    - `useColorModeSettingFor`
    - `usePreviewColorScheme`
    - `useResolvedTheme`
    - `useSetAppColorMode`
    - `useSetGlobalColorMode`
    - `useThemes`
    - `useThemeScopeId`
    - `useThemeSelections`
    - `whenNoScopeSelects`
- Server:
  - Contributes:
    - `ConfigV2.Register` "color-mode"
    - `ConfigV2.Register` "theme"
    - `DocumentHead.Fragment` "theme-engine"
  - Uses:
    - `apps-core.declaredApps`
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `config_v2.getConfigScopeIds`
    - `config_v2.onConfigDirChange`
    - `shell/document-head.DocumentHead`
    - `shell/document-head.HeadFragments`
  - Exports (types): `ServerThemeSource`
  - Exports (values): `ThemeEngine`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/dynamic-enum/config.dynamicEnumField`
    - `fields/enum/config.enumField`
    - `packages/list-bound.wholeList`
    - `packages/list-bound.wholeRecord`
    - `primitives/css/ui-kit.appThemeScope`
    - `primitives/css/ui-kit.ROOT_SCHEME_SELECTORS`
    - `primitives/css/ui-kit.SchemeSelectors`
    - `primitives/css/ui-kit.subThemeScope`
    - `primitives/css/ui-kit.themeScopeSelectors`
    - `primitives/pane.APP_COLOR_MODES`
    - `primitives/pane.AppColorMode`
    - `ui/theme-engine/token-var-name.tokenVarName`
  - Exports (types):
    - `AppColorModeOverride`
    - `ColorAdjustment`
    - `ConfiguredColorMode`
    - `FixedTheme`
    - `GroupValues`
    - `ResolvedTheme`
    - `SkippedThemeValue`
    - `SubTheme`
    - `Theme`
    - `ThemeId`
    - `ThemePaintSelection`
    - `ThemePaintSources`
    - `ThemeResolution`
    - `ThemeSource`
    - `TokenGroupDescriptor`
    - `TokenGroupField`
    - `TokenGroupFragment`
    - `TokenGroupSchema`
    - `TokenGroupSpec`
    - `TokenValues`
    - `TokenVarOf`
  - Exports (values):
    - `appColorModeConfig`
    - `assertUniqueFixedThemes`
    - `both`
    - `CANVAS_STYLE_ID`
    - `ColorAdjustmentSchema`
    - `DEFAULT_THEME_ID`
    - `defineFixedTheme`
    - `defineSubTheme`
    - `defineTheme`
    - `defineTokenGroup`
    - `effectiveColorMode`
    - `fixedThemeGroupValues`
    - `isBuiltInThemeId`
    - `lightOnly`
    - `mergeGroupValues`
    - `NEUTRAL_COLOR_ADJUSTMENT`
    - `paintThemeStyles`
    - `parseAppColorModeOverride`
    - `parseConfiguredColorMode`
    - `renderCanvasBlock`
    - `renderSubThemeBlock`
    - `renderThemeGroupBlock`
    - `resolveFixedTheme`
    - `resolveTheme`
    - `subThemeBlocks`
    - `subThemeBlockValues`
    - `THEME_STYLE_ID_PREFIXES`
    - `themePainter`
    - `themeSelectionConfig`
    - `themeStyleId`
    - `TokenGroupFragmentSchema`
    - `TokenGroupFragmentsSchema`
    - `tokenGroupMatchesSearch`
    - `transformValues`
- Cross-plugin:
  - Uses tokens: 66 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×26
    - `ui/tokens/density` ×26
    - `ui/tokens/shadow` ×4
    - `ui/tokens/shape` ×4
    - `ui/tokens/type-scale` ×4
    - `ui/tokens/data-view` ×2
  - Imported by: 53 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui` ×29
    - `apps` ×18
    - `apps-core/chrome-theme`
    - `companions/panel`
    - `hints`
    - `map`
    - `media/player`
    - `reports/theme-resolution`
- Exemptions:
  - Exempts itself from: `check-thread-safety/no-blocking-check-work` — `check/index.ts` (debt)
- Sub-plugins:
  - **`quick-theme`** — Quick-switch theme popover on the global action bar: contributed quick sections (the theme picker, the light/dark switch), every component variant picker, and a hand-off to the full customizer pane…
  - **`saved-themes`** — Saved themes (tweakcn imports and custom themes) as a resident theme source read live (saved-themes.list, hydrated before first paint), plus useEditTheme — the one place theme edits land, copying a…
  - **`theme-customizer`** — Extensible theme customization pane: per-app theme toggle, component variant pickers, search, and contributed sections, plus the token-group editor kit (useTokenGroupEditor, TokenRows, FillFromMenu)…
  - **`theme-gallery`** — The Theme DataView: every selectable theme plus every catalog's unsaved entries, with My themes / Community / Curated views. Picking one selects it for the current scope (saving a catalog entry…
  - **`token-var-name`** — The CSS custom property a token-group schema key paints (tokenVarName: `--` + its kebab case). A leaf with no imports, so the static token-group reader (token-usage, run by the cross-refs facet)…

<!-- AUTOGENERATED:END -->
