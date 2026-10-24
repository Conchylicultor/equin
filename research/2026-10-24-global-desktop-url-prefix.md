# Desktop owns a URL: `/desktop/<route>`

## Context

The Desktop (`apps/desktop`) is a *surface-mode app*: picking it switches the
ONE tab set's surface to the `floating` placement, and its windows are the
shell's ordinary in-app tabs. It owns no URL — `isTabApp` keeps it out of URL
matching — so it cannot be opened from outside equin: the menu-bar panel's app
grid leaves it out, and `installableApp` refuses to install it as an OS app.

Decision (option A of the conversation): Desktop stays a surface mode, and its
`basePath` becomes a **URL prefix** for that mode. While the surface is in
desktop mode the address bar is `/desktop` + the focused window's own URL
(`/desktop/agents/c/conv-x`); bare `/desktop` is the desktop with no window. The
URL then says everything: a reload, a bookmark or a shared link lands back in
the desktop with that window, and the installed OS app's scope is plain
`/desktop` — no container shim, no change to the Rust helper.

Rejected: Desktop as a tab app hosting `AppEmbed` windows (a second, weaker tab
system), and a whole-origin "container" shim (needs handoff opt-outs and claims
every unowned link).

## Design

### 1. One prefix concept, owned by the pane primitive

The pane primitive owns the sanctioned URL read (`currentRoutePath`), so it owns
the prefix too (`primitives/pane/web`, new `internal/route-prefix.ts`):

- `setRoutePrefixes(prefixes)` — the known prefixes (installed by apps-core from
  the eager `Apps.App` entries carrying a `surfaceMode`: their `app.basePath`).
- `splitRoutePrefix(pathname)` → `{ prefix?: string; path }` (pure over the
  installed set; `/desktop` → `{prefix:"/desktop", path:"/"}`).
- `currentRoutePath()` returns the path **with any known prefix stripped**, so
  every routing consumer (app matching, base-path strip, `handleLocationChange`,
  the commit no-op guard, `rawPathForTab`, the layout) keeps seeing plain app
  routes. `currentRoutePrefix()` returns the prefix the address bar carries.
- `setActiveRoutePrefix(prefix | undefined)` / `withActiveRoutePrefix(url)` —
  the prefix the current surface mode writes, applied by every URL WRITER and
  every link `href` built by the pane / tabs layers.

The pane store itself stays prefix-ignorant: reads strip, the shell history
adapter's `commit` adds — the same seam the `?embed=` re-stamp already uses.

### 2. apps-core: mode ↔ prefix

- `apps-core/web`: `routePrefixOf(entry)` / `surfaceModeForPrefix(prefix, apps)`
  / `routePrefixForMode(mode, apps)` derived from `Apps.App` (`surfaceMode` +
  `app.basePath`) — no second constant. The layout installs
  `setRoutePrefixes` before its first read.
- Pre-boot loader (`web-core/App.tsx` `resolveActiveAppPrefix`): strip a
  surface-mode contribution's base path first, so `/desktop/agents/…` front-loads
  the agent manager (and bare `/desktop` the desktop).

### 3. tabs: boot, write, switch, restore

- **Boot** (`bootTabs`): the URL prefix decides the mode — prefix present ⇒ that
  surface mode (URL wins over persisted, as the URL's app wins over the
  persisted focus); no prefix while the persisted mode owns one ⇒ `""` (the
  default). Bare prefix (`/desktop`) ⇒ the empty surface, never a home tab.
- **Write** (`shell-history-adapter.commit`): `withActiveRoutePrefix(url)` before
  `embedUrl`. The active prefix is set synchronously from `modeRef` (boot and
  `setMode`), not from the effect-published module mode.
- **Mode switch** (`setMode`): re-project the current entry with
  `replaceState` (new adapter method `reproject()`), so entering the desktop
  turns `/agents/c/x` into `/desktop/agents/c/x` and leaving turns it back.
- **Back/forward** (`restore`): if the entry's prefix names a different mode than
  the current one, switch to it (no prefix while in a prefixed mode ⇒ the
  default placement).
- **Links**: `appLink`/`useAppLink` hrefs, the pane's `routeUrl`-based hrefs and
  `useActivateApp`'s hrefs go through `withActiveRoutePrefix`, so ⌘-click opens
  a desktop in the new browser tab, and in the installed window they stay in
  scope. A surface-mode app's activation gains `href: basePath`.
- **Layout canonicalization**: bare `/` redirect only when the URL carries no
  prefix — `/desktop` is the desktop's own address, never redirected to home.

### 4. Install + menu bar

- `installableApp`: any listed app owns a URL (drop `launch === "tab"`).
- `app-manifest` and `theme-engine` document-head: key every app (incl. the
  desktop at `/desktop`), so `/desktop/…` first paints in the desktop theme and
  serves its manifest.
- Menu-bar app grid: drop the `isTabApp` filter; a tile opens `basePath`
  (`/desktop`) like any app.
- Helper (`rust/`): unchanged. The installed window loads `/desktop?embed=1`;
  the prefix gives it desktop mode even in an embedded document (where the tab
  set is not persisted).

## Out of scope (follow-ups)

- Restoring the desktop's windows when the installed app is relaunched (a
  durable desktop session — sessionStorage is per instance, and an embedded
  document persists nothing). The URL restores the focused window on reload only.
- Installed windows as `standalone` rather than `?embed=1` (own storage).
- Raw `<a href>` anchors with literal in-app paths inside the installed Desktop
  are handed off by the helper's `scope.js` (link gestures built on `linkProps`
  are buttons and are unaffected).

## Files

- `primitives/pane/web/pane.ts` (`currentRoutePath`, hrefs), new
  `primitives/pane/web/internal/route-prefix.ts`, barrel.
- `apps-core/web/internal/resolve-app.ts` (+ prefix helpers), `slots.ts` docs.
- `apps-core/tabs/web/internal/{use-tabs.tsx,shell-history-adapter.ts,app-link.ts,use-navigate.ts,use-activate-app.ts}`.
- `apps-core/layout/web/components/apps-layout.tsx`.
- `framework/web-core/web/App.tsx`.
- `apps-core/app-manifest/{core/manifest.ts,server/internal/document-head.ts}`,
  `ui/theme-engine/server/internal/document-head.ts`.
- `menu-bar/app-grid/web/components/app-grid.tsx`; docs in `apps-core`,
  `menu-bar`, `app-manifest`, desktop `shell/core/app.ts`.

## Verification

- Unit: `route-prefix` split/strip; `bootTabs` with `/desktop`, `/desktop/x`,
  `/x` + persisted desktop; shell adapter commit adds the prefix; existing tabs
  tests (`boot-tabs`, `shell-history-adapter`, `empty-surface-open`,
  `mode-switch-keepalive`, `active-app-boot`).
- `./equin build`, then with `browser_*`: open `/desktop` (empty desktop),
  `/desktop/agents` (desktop with the agent manager window), switch mode in and
  out (address bar gains/loses the prefix), Back across the switch, reload.
- Menu-bar panel (`/home/menu-bar?embed=1`) lists Desktop; `GET
  /api/apps/desktop/manifest.webmanifest` answers.
