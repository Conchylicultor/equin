# apps-core

## An app is authored once, and `Apps.App` takes it whole

An app's id, base path, display name, icon and tile colour live in exactly one
place: `defineApp({ … })` in that app's shell `core/app.ts`
(`icon: symbol("description")`, optional `iconColor: "slate"`). The web barrel
hands the resulting `AppRef` over whole:

```ts
Apps.App({ app: pagesApp, component: PagesLayout })
```

The contribution restates **nothing**: there is no `id`, `path`, `tooltip` or
`icon` prop, so drift has no spelling. Readers still get `entry.icon` (an
`AppIcon`): `Apps.App` derives it from `app.icon` + `app.iconColor`. `Apps.App` is a hand-declared callable (not a
bare `defineRenderSlot`) purely so it can derive the framework-required
contribution id from `app.id` and the icon from the `AppRef`. Consumers read `entry.app.name` /
`entry.app.basePath`; a lower layer that needs an app's name reads it off the
`AppRef` it already holds, never by looking into `apps-core`.

## An app can be unlisted

`defineApp({ listed: false })` keeps an app out of every launcher — the rail,
the app galleries and launcher grids (`isListedApp`), and the installable set
(`installableApp`, which also gives it no manifest at its path) — while it keeps
its URL, its tab and its `app:<id>` scope. For an app opened at its URL by
something outside equin: the menu-bar panel (`menuBarApp`, mounted at
`/home/menu-bar`, inside Home's path — the longest base path wins).

## Two kinds of app entry: a tab app, or a surface-mode app

`AppEntry` carries exactly one of two launches (`AppLaunch`, a union tsc keeps
exclusive):

- `component` — a **tab app**: picking it opens (or swaps in) a tab at its base
  path. Every regular app.
- `surfaceMode` — a **surface-mode app**: picking it switches the surface to that
  `Surface.Placement` id. The desktop (`plugins/apps/plugins/desktop`) is one: a
  real app with a name, an icon, launcher presence and its own `app:desktop`
  theme and config scope, whose windows are nevertheless the shell's ordinary
  in-app tabs. It never becomes a tab; its URL is its base path as a **route
  prefix** (below).

Anything tab-side — URL matching, the tab set, what a tab renders — reads
`isTabApp(entry)` (`web/internal/resolve-app.ts`); `matchAppForPath` already
skips surface-mode entries. Activation (`useActivateApp`) runs the mode switch
for the second arm, so the rail, the launcher popover and the Home gallery need
no per-kind code.

## A surface-mode app's URL is a route prefix

While the surface is in a surface-mode app's mode, the address bar is that
app's base path IN FRONT of the focused tab's own URL: `/desktop/agents/c/42`
is the desktop, focused on that conversation's window; bare `/desktop` is the
desktop with no window. So a reload, a bookmark or a link lands back in the
desktop, and the desktop installs and opens from the menu bar like any app
(scope `/desktop`). Design: `research/2026-10-24-global-desktop-url-prefix.md`.

- **Read** — `useInstallRoutePrefixes()` (first thing `AppsLayout` does)
  installs every surface-mode base path as a known prefix
  (`primitives/pane/plugins/route-prefix`); `currentRoutePath()` strips it, so
  nothing below sees it, and `currentRoutePrefix()` says which one the URL
  carries. The pre-boot loader (`web-core/App.tsx`) strips it by shape too.
- **Mode** — `bootTabs`: the URL's prefix names the mode (it wins over the
  persisted one); a bare prefix on a fresh instance boots the empty surface.
  Back/forward re-applies the entry's prefix's mode (`syncModeFromUrl`).
- **Write** — the tabs layer sets the active prefix from the requested mode;
  the shell history adapter writes it in front of every URL, a mode switch
  re-writes the current entry in place (`reproject`, a replace), and
  `openInBrowserTab` puts it in front of an in-app path.
- **Pairing** — `routePrefixForMode` / `surfaceModeForPrefix` derive it from
  the `Apps.App` entries: the prefix is the app's `defineApp` base path.

## A surface mode can own the frame

A `PlacementDef` with `ownsChrome` (solo, the desktop) draws its own frame: the
layout then mounts no tab bar, the rail framing renders no rail
(`RailFramingProps.showRail` — the body stays at the same tree position, so no
keep-alive tab remounts), and the global action bar floats as its dot. One
capability (`placementOwnsChrome`) decides all three, so they cannot disagree.

## A surface mode can allow an empty surface

A `PlacementDef` with `allowsEmpty` (the desktop) lets the tab set go to zero:
closing the last tab leaves no tab, `focusedTabId` is `undefined`, no pane store
is live and the address bar is bare `/` (which the apps layout's home
canonicalization leaves alone while `peekSurfaceEmpty()`). Every other mode keeps
at least one tab: closing the last one, or switching to such a mode from an
empty surface, seeds the composition's home app. With no tab, `navigate()` and an
app pick open a new tab instead of re-routing one. Opens that go through the
live pane store (`useOpenPane` in global chrome, `openPane`, `restoreRoute`)
work too: while the surface is empty the live store is an **empty-surface
store** based at the home app, and the first route it receives becomes a new
focused tab (a pane homed in another app goes through `navigate()` instead). Picking a surface-mode app
from the home app consumes the home tab (`useActivateApp`), so the gallery's
Desktop tile opens a clear desktop. Its activation is a link to its base path,
so ⌘/middle-click opens a desktop in a new browser tab.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: App switcher rail. Wraps per-app shells; plugins contribute via Apps.App. Every app the browser registers, readable on the server: declaredApps — each Apps.App contribution's whole AppRef (id, name, base path, icon, tile colour) and its launch kind (tab or surface mode), generated at build time from the web contributions.
- Load-bearing: yes
- Web:
  - Slots:
    - `Apps.App`
    - `Apps.RailFraming`
    - `Apps.Surface`
    - `Apps.TabBar`
    - `Apps.TabBarActions`
    - `Apps.Overlay`
  - Slot contributors: 25 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `Apps.App` ×20
    - `Apps.Overlay` ← `apps-core.app-launcher`
    - `Apps.RailFraming` ← `apps-core.app-rail-framing`
    - `Apps.Surface` ← `apps-core.surface`
    - `Apps.TabBarActions` ← `shell.global-action-bar`
    - `Apps.TabBar` ← `apps-core.tab-bar`
  - Uses:
    - `audience.useAudience`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceResult`
    - `primitives/pane.currentRoutePath`
    - `primitives/pane.stripBasePath`
    - `primitives/pane.useSurfaceAppId`
    - `primitives/pane/route-prefix.setRoutePrefixes`
    - `primitives/slot-render.defineRenderSlot`
    - `primitives/slot-render.RenderSlot`
  - Exports (types):
    - `ActiveApp`
    - `AppEntry`
    - `AppLaunch`
    - `AppListing`
    - `HomeApp`
    - `OverlayContribution`
    - `Placement`
    - `RailFramingContribution`
    - `ResolvedApp`
    - `SurfaceContribution`
    - `TabBarContribution`
  - Exports (values):
    - `Apps`
    - `homeApp`
    - `isTabApp`
    - `matchAppForPath`
    - `resolveAppForPath`
    - `routePrefixForMode`
    - `setFocusedApp`
    - `surfaceModeForPrefix`
    - `useActiveApp`
    - `useAppListing`
    - `useCurrentAppId`
    - `useFocusedAppId`
    - `useHomeApp`
    - `useInstallRoutePrefixes`
    - `usePathname`
- Cross-plugin:
  - Imported by: 56 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×27
    - `apps-core` ×12
    - `ui` ×6
    - `config_v2` ×2
    - `hints` ×2
    - `menu-bar` ×2
    - `debug/icons`
    - `plugin-meta/exhibits`
    - `reports/main-thread-stall`
    - `shell/global-action-bar`
    - `tasks/task-draft-form`
- Exemptions:
  - Exempted by: `apps-core/layout` (0 debt)
- Server:
  - Exports (values): `declaredApps`
- Core:
  - Exports (types):
    - `AppDeclaration`
    - `Placement`
    - `RailFramingProps`
  - Exports (values): `APP_RAIL_WIDTH`
- Test helpers:
  - Web: `@plugins/apps-core/web/testing`
    - `getFocusedAppId`
- Sub-plugins:
  - **`app-embed`** — <AppEmbed app route onLeave? />: one app surface rendered in-process — the SurfaceCore a tab mounts — with its own non-live pane store (seeded with route, never touching the page URL), its app theme…
  - **`app-icon`** — Canonical, serializable app-icon descriptor (a Material Symbols glyph now, image variant later), drawn by the icons primitive.
  - **`app-launcher`** — The app brand every app shell draws (AppShell.Brand): the launcher — the current app's own mark — click for the composition's home app (the app gallery on main), hover or ArrowDown for a grid of…
  - **`app-manifest`** — Makes every listed app installable as its own OS app: serves GET /api/apps/:appId/manifest.webmanifest (id / start_url / scope = the app's base path, its tile colour, its icon PNGs) from the…
  - **`app-rail`** — App rail: the far-left icon strip that switches the focused tab between apps, deriving its own active-app highlight and chrome theme scope.
  - **`app-rail-framing`** — App-rail framing region (rail / hidden). Contributes its variant-region host into Apps.RailFraming.
  - **`app-usage`** — Records per-app usage from the browser — a launch whenever the focused app changes to another, active time while the app is focused, the page visible, the window focused and the user not idle for 5…
  - **`chrome-theme`** — The app chrome's fixed theme (graphite): the rail, tab bar, action bar and toasts wear it whichever app is focused, so the frame stays the same while the app inside changes.
  - **`layout`** — Apps layout: the Core.Root composition wiring the tab bar, rail framing, and surface together, with the default-app redirect and document-title sync.
  - **`surface`** — Generic surface dispatcher: renders every open tab at once under the ONE surface mode (docked / windows / solo) selected from the Surface.Placement registry, so the modes are mutually exclusive.…
  - **`tab-bar`** — App tab bar: the top tab strip with per-tab titles, overflow collapse, drag reorder/tear-off, and the new-tab/new-window + button.
  - **`tab-surface`** — Per-tab surface render core: TabSurface mounts a tab's PaneSurfaceProvider and reports its leaf title; AppTabsBody is the keep-alive fallback body that stacks every open tab.
  - **`tabs`** — Tab manager for the app switcher: the open-tab set, focus model, cross-app navigate(), the focused-placement module store, the focused tab's title as a module signal (useFocusedTabTitle, readable…
  - **`theme-scope`** — Theme-scope helpers: the single definition of the focused full-surface app's theme scope, which decides the :root token layer and the document's light/dark (useRootThemeScopeState keeps the…

<!-- AUTOGENERATED:END -->
