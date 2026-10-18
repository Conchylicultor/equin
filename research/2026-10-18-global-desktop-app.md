# Desktop app — the floating desktop mode, rebuilt to the mockup

## Context

The floating surface mode ("desktop mode", `apps-core/plugins/surface/plugins/floating`) is to match prototype
`proto-1792144948-0pxmsf` pixel for pixel: no tab bar and no app rail, one bottom shelf (launcher, pinned apps,
running windows, tray with pager + clock), a ⌘K launcher, overview, a window switcher, hover thumbnails, and the
mockup's menus. Today the mode draws inside the classic frame (tab bar on top, rail on the left), its dock lists
windows only, and its `CLAUDE.md` forbids launching from the desktop.

The desktop already calls itself a meta-app (`apps-core/core/app.ts` `desktopApp = { id: "desktop" }`, data dir
`apps/desktop` via a `META_APP_ROOTS` exception). This plan makes it a real app — its own plugin, identity, theme,
settings and app-menu entry — while its windows stay the shell's ordinary in-app tabs (URL, history, keep-alive
untouched). It is **not** rendered inside a tab: an app-in-a-tab would have to `<AppEmbed>` every window (non-live
pane stores, no deep links, nested tab models).

### Decisions taken with the user

| Topic | Decision |
|---|---|
| Global action bar | Stays the floating dot, exactly as in solo. |
| Mockup variants | Only the defaults: `shelf: dock`, `instances: grouped`, `titlebar: seamless`, `wallpaper: elarun`. No settings for the others. |
| Titlebar | Seamless for every app, except apps whose shell draws a sidebar (classic: tinted bar + bottom border, as the mockup's `.has-side`). Derived, not configured. |
| Pinned apps, wallpaper | Global desktop config (same in every worktree). Mockup wallpapers shipped as built-ins. |
| Thumbnails | A static DOM snapshot taken on hover, rebuilt every time. |
| Theme | The desktop has its own theme (`app:desktop` scope), independent of the fixed graphite chrome theme the action-bar dot wears. |
| Windows | Stay mixed-app (any tab can join any window, `+` opens Home). A window is filed under the app of its **active** tab. |
| App tiles | One gradient from the desktop theme's accent for every app (no per-app colour for now). |
| Full screen | Keeps switching the surface to solo. |
| Shortcuts | Keep the existing set, add the mockup's few (below). |

## Plugin layout

```
plugins/apps/plugins/desktop/            namespace; data-dirs/index.ts only
├── data-dirs/index.ts                   desktopDir = defineAppDataDir(desktopApp, { owner: "apps/desktop", movedFrom wallpaper })
└── plugins/
    ├── shell/        core/app.ts desktopApp = defineApp({ id: "desktop", name: "Desktop", basePath: "/desktop", iconKey })
    │                 core/config.ts desktopConfig (global): pinnedApps (stringListField)
    │                 web: the Apps.App mode entry, DesktopTheme (<Theme name={appThemeScope("desktop")}>), curated default theme
    ├── windows/      ← moved from apps-core/plugins/surface/plugins/floating (store, chrome, snap, motion, tab drag, system menu)
    │                 exports WindowSnapshot (the hover-snapshot renderer, used by shelf / pager / switcher)
    ├── shelf/        the bottom dock: launcher button, pinned + running entries, peek thumbnails, app menu, tray (pager, overview button, clock)
    ├── launcher/     ⌘K dialog: all-apps grid, search over apps + commands
    ├── overview/     F3 exposé + "Tile all windows"
    ├── switcher/     mod+` panel of snapshots (replaces the silent cycle)
    └── wallpaper/    ← moved from floating/plugins/wallpaper (+ built-in source)
```

Moves use `./singularity plugin move` (rewrites every reference). The placement id stays `"floating"` so persisted
surface modes keep working; its label becomes "Desktop". `apps/plugins/*` may import `apps-core/*/web`, so
`Surface.Placement(…)` contributed from `desktop/windows` is legal.

**`META_APP_ROOTS` goes away.** `apps-core/data-dirs/index.ts` moves to `apps/plugins/desktop/data-dirs/index.ts`
(owner `apps/desktop`, keeping `movedFrom: [{ from: "apps/wallpaper", to: "wallpaper" }]`). Delete the `desktop` row
and the `metaAppRoots` plumbing (`paths/core/internal/data-dir.ts:252`, `app-data-dirs.ts`, `paths/check/index.ts`,
both re-exports, the tests' meta cases, the prose in `paths/CLAUDE.md` and `apps-core/CLAUDE.md`). `apps-core/core`
drops `desktopApp`.

## 1. Chrome: the mode owns the frame

- **`PlacementDef.ownsChrome?: true`** (`apps-core/plugins/surface/web/slots.ts`): "this mode draws its own frame —
  no tab bar, no rail". Derived into a new `ownsChrome` set in `PlacementCapabilities`
  (`apps-core/plugins/tabs/web/internal/placement-registry.ts`) with a `placementOwnsChrome(caps, id)` predicate, the
  same way as `newTabFollows` and `appThemeScope`.
- `apps-layout.tsx`: `TabBarHost` renders nothing and `FramedSurface` takes `RaillessFraming` when the focused mode
  owns its chrome (beside the existing `isChromelessDocument()` arm).
- **Solo declares it too**, and `useActionBarPinned`
  (`shell/plugins/global-action-bar/web/internal/use-action-bar-pinned.ts`) becomes
  `!placementOwnsChrome(caps, mode)` instead of `mode !== "solo"`. The action bar shows the floating dot in solo and
  desktop through one rule, and the string compare is gone. Solo's tab bar was covered, now it is unmounted (exiting
  solo remounts it — cheap).
- The other `"solo"` string compares stay as they are (they really are about solo).
- The action-bar dot sits top-right over the desktop. A window that reaches the top-right corner (maximised, or
  right/top-right snaps) insets its titlebar controls by the existing `--floating-bar-safe-area`.

## 2. Identity and the app-menu entry

- `desktopApp` is a regular `defineApp`. It is contributed as **`Apps.App({ app: desktopApp, icon, activate: { surfaceMode: "floating" } })`**.
  `AppEntry` becomes a union: `component` (opens a tab — every existing app) **xor** `activate.surfaceMode` (switches
  the surface mode, never opens a tab). tsc keeps the arms exclusive.
  - `useActivateApp` (`apps-core/plugins/tabs/web/internal/use-activate-app.ts`) runs `setSurfaceMode` for the mode arm.
    The rail, the app-launcher grid and the Home grid all activate through it, so the entry works everywhere with no
    per-consumer code.
  - A mode entry owns no URL: `matchAppForPath` / `resolveAppForPath` skip it (so `/desktop` stays unmatched).
  - Fold the existing `onClick` escape hatch into this union if its only users fit (check its call sites first).
- The way back out stays the existing placement control (action-bar gear popover). The launcher also gets a
  "Leave desktop" command.

## 3. Desktop theme

- Everything the desktop draws — wallpaper backdrop, shelf, peek popover, menus, launcher, overview labels, switcher,
  snap ghost — sits under `<DesktopTheme>` = `<Theme name={appThemeScope(desktopApp.id)}>`. Popups use `PopupTheme`
  with the same scope. Windows keep their own app's theme (each tab container is already a `<Theme surface="canvas">`).
- `:root` stays global in desktop mode (no `themeScope: "app"`), as today.
- The desktop is an app, so it gets its own entry in the per-app theme selection (`themeSelectionConfig`, `scope: "app"`).
  Ship a curated **Desktop** theme carrying the mockup tokens (dark, Inter, accent `#4f6bff`, its shadows and radii) as
  the `app:desktop` default.
- To check while building: that the theme injector emits a CSS block for a scope that has no tab
  (`ui/plugins/theme-engine` `GroupStyle`), and how a per-app default selection is declared.
- App tiles: white glyph on `linear-gradient(160deg, <accent lightened>, <accent>)` from the desktop theme, radius 12,
  inset hairline + 1px shadow (mockup `.sh-item .app-ic`). A tile component in `desktop/shell` is shared by shelf,
  launcher, peek header and switcher.

## 4. Shelf (`desktop/shelf`) — replaces `window-dock.tsx`

Foreground of the placement, bottom-centred, mockup `dock` geometry (46px tiles, separators, hover lift −4px, press
scale .97).

- **Order:** launcher button | pinned apps | running-but-unpinned apps | tray. Pinned apps come from
  `desktopConfig.pinnedApps`. The default is the apps the mockup pins that exist here: Agents, Mail, Pages.
- **Entries are grouped per app** (`instances: grouped`). An app's windows are the windows on the active desktop
  whose active tab is that app. Under the tile: up to 3 pips, and the pip is accent-coloured when the focused window
  is one of them. A count shows when there are more than one. The badge is `AppEntry.badge`, the existing field.
- **Click:** no window → open the app (a new tab = a new window). One window → focus it, restore it, or minimise it
  when it is already in front. Several → the first click brings the latest forward, later clicks cycle. Shift-click or
  middle-click → new window.
- **Right-click → app menu:** header, one row per window (checked = focused), New window, Keep in dock / Remove from
  dock, Minimise/Restore, Close N windows.
- **Hover → peek popover:** one `WindowSnapshot` per window (header: tile, title, "N tabs", ×), and a `+` new window.
  Hovering a thumbnail highlights its window and dims the rest (mockup `.peeking`). An app with no window shows a
  name tooltip.
- **Minimise motion** aims at the real shelf entry rect (today it aims straight down).
- **Work area:** maximise and snap boxes reserve the dock height + 16px (mockup `work()`).
- **Tray:**
  - Pager mini-desktops (54px wide, desktop aspect) reuse `DesktopMinimap`, plus their × and `+`.
  - Hovering a mini shows a desktop preview: wallpaper plus snapshots of that desktop's windows at their positions,
    with a "Desktop N · k windows · current" header.
  - Right-clicking a mini opens: Switch to, New desktop, Close desktop.
  - Then the overview button and a clock (`HH:MM`, `Fri 16 Oct`). The clock re-arms a timeout at each minute
    boundary. That is a clock, not polling a source; check for an existing clock primitive first.
- `floating/CLAUDE.md`'s "no launcher on the desktop / the dock lists windows only" invariant is rewritten. The
  shelf *is* the launcher in a mode that has no rail.

## 5. Windows (`desktop/windows`) — chrome, menu, snap

- **Titlebar** as in the mockup:
  - Left, the app button (tile + app name + chevron) opens the window menu.
  - Then the tab strip, with the `+` shown on hover.
  - Then the controls: keep on top, minimise, maximise, full screen (→ solo, unchanged), close.
  - An inactive window greys its tile and fades its controls.
- **Seamless vs classic is derived**, not configured. `AppShellLayout` publishes, per surface, whether it draws a
  sidebar (a registry like `primitives/app-shell` `brand-presence`, e.g. `useSidebarDrawnOn(surfaceId)`). The window
  chrome reads it for its active tab.
  - Delete `floatingChromeConfig`, `TitlebarStylePicker` and the `floating-titlebar` VariantGroup.
  - Sidebar apps today: debug, pages, file-explorer, settings, agent-manager, studio, events, mail.
- **Window menu**, in mockup order:
  - Restore, Minimise, Maximise/Unmaximise, Full screen
  - Keep on top
  - Snap ▸ (left/right halves | four quarters)
  - Move to desktop ▸ (desktops, then New desktop)
  - Merge tab into ▸ (other windows, else "No other windows")
  - Move tab to new window
  - Close window
  - The keyboard Move / Size modes leave the menu (the mockup has none). Their code goes too unless something else
    reaches it.
- **Snap and drag thresholds** become the mockup's:
  - Edge band 10px. Corner band `min(120, 20% of h)`.
  - Top ≤ 2px → maximise.
  - Gap 6px. Maximise fills the work area edge to edge.
- Tab drag (reorder / merge / tear-off) is kept. Restyle the ghost, the insertion mark and the tear-off preview
  ("New window" outline) to the mockup's look.

## 6. Launcher, overview, switcher

- **Launcher** (`mod+k`, plus the shelf button, desktop mode only):
  - A centred panel with "Search apps and commands…" and an `esc` key hint.
  - An empty query shows an "All apps" grid (running dot, arrow keys move by grid columns).
  - A query shows Apps rows ("N windows", "Switch to"/"Open") and Commands rows (with their key hints), or
    "No results for …".
  - Enter opens, Shift+Enter opens a new window. Right-click a tile → Open / New window / Keep in dock.
  - Footer hints. Apps come from `Apps.App.useContributions()`.
  - **Commands are the registered shortcuts and commands** of the Window/Desktop groups, read from the shortcuts
    registry (`primitives/shortcuts`; extend it with a read API if it has none) plus a few command-only entries
    (Tile all windows, New desktop, Close this desktop, Minimise all, Leave desktop). No second hard-coded list.
- **Overview** (`F3`, tray button):
  - The active desktop's visible windows animate (transform only) into a grid laid out as in the mockup's
    `enterOverview`, each labelled "App — title".
  - Clicking a window picks it. A click on the empty desktop or Esc exits.
- **Switcher** (`mod+\``, `mod+shift+\``):
  - Holding the modifier shows a panel of snapshots in z order, with the selected one's title under it.
  - Releasing commits, Esc cancels. It replaces the silent `cycleWindows` and keeps its shortcut ids.
- **Shortcuts added:** `mod+k` launcher, `F3` overview, `alt+n` new window of the focused app. All the existing
  `floating.*` shortcuts stay.

## 7. Snapshots

`WindowSnapshot` takes the window's container element at the moment it is shown: `cloneNode(true)`, strip resize
handles and transient classes, `inert`, then scale it into the thumbnail box (mockup `thumbFor`). It is rebuilt on
every hover and never kept. Known limit: canvases and iframes come out blank (Sonata, maps). Accepted.

## 8. Wallpaper

- Moves to `desktop/wallpaper`. `wallpaperConfig` stays global and gains a `kind: "builtin", id` arm.
- The six mockup images (Elarun, Shell, Fold, Amber, Opal, Kokkini, ~2.3 MB total) are bundled as `.jpg` imports in
  a "Built-in" picker source, with their licences shown in the corner credit (mockup `CREDITS`; LGPLv3 / CC BY-SA).
- The default becomes **Elarun**. "Reset to default" returns to it, and the theme-gradient SVG stays as one built-in.

## Critical files

- `plugins/apps-core/plugins/surface/web/slots.ts`, `.../tabs/web/internal/placement-registry.ts`, `.../layout/web/components/apps-layout.tsx`
- `plugins/apps-core/web/slots.ts` (`AppEntry` union), `.../tabs/web/internal/use-activate-app.ts`, `matchAppForPath`
- `plugins/shell/plugins/global-action-bar/web/internal/use-action-bar-pinned.ts`
- `plugins/apps-core/plugins/surface/plugins/solo/web/solo-placement.tsx` (`ownsChrome`)
- Everything under `plugins/apps-core/plugins/surface/plugins/floating/` (moved; `window-chrome.tsx`, `window-system-menu.tsx`, `use-snap.ts`, `use-window-motion.ts`, `window-dock.tsx` → shelf)
- `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` (+ the sidebar-presence registry)
- `plugins/infra/plugins/paths/core/internal/data-dir.ts`, `app-data-dirs.ts`, `paths/check/index.ts` (meta-app removal)
- `plugins/apps-core/CLAUDE.md`, `floating/CLAUDE.md` (→ `desktop/windows/CLAUDE.md`), `paths/CLAUDE.md`

## Order of work (one branch, reviewed together)

1. Move: create `apps/desktop` with shell + data-dirs, move floating → `windows` and wallpaper, remove `META_APP_ROOTS`. Build green, behaviour unchanged.
2. `ownsChrome` + the action-bar rule + the mode entry in the app menu.
3. Desktop theme + tiles + shelf (replacing the dock) + tray + built-in wallpapers.
4. Window chrome / menu / snap values / derived seamless.
5. Snapshots, peek, desktop preview, launcher, overview, switcher.

## Verification

- `./singularity build` (checks: boundaries, `paths:app-data-dirs`, `plugins-registry-in-sync`, type-check).
- `./singularity test plugins/apps/plugins/desktop plugins/apps-core`: move the existing floating tests; add unit
  tests for shelf grouping (active-tab app, pinned/running order), mode-entry activation, and the mockup snap
  thresholds in `use-snap.test.ts`.
- New `plugins/apps/plugins/desktop/e2e/desktop-verify.ts`. It enters desktop mode from the app menu and asserts:
  - no tab bar or rail, and the action-bar dot is present
  - the shelf opens an app
  - hover shows the peek, ⌘K opens the launcher, F3 opens the overview, mod+\` opens the switcher
  - the pinned set persists across reload
- Pixel comparison: screenshot the real desktop (`screenshot.ts --path … --viewport 1440x900`) and the prototype at
  the same size with the same windows open, and compare side by side. Add `<meta name="mocks">` to the prototype if
  `compare-diff.ts` can address the mode.
