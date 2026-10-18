# windows

The desktop's windows: the floating-window surface placement (`Surface.Placement`
id `"floating"`, label "Desktop"), the window store, their titlebar and window
menu, snapping, the motion, the overview and the shelf's peek. The desktop's
other chrome — the shelf, the launcher, the switcher — are plugins of their own,
mounted through this plugin's `Desktop.Overlay` slot. The look is the mockup's
(`proto-1792144948-0pxmsf`, its default variants); its timings, sizes and
shadows are spelled as commented literals where no theme token expresses them.

## The desktop draws its own frame

The placement `ownsChrome`: no tab bar, no app rail. Launching and switching
live on the desktop itself — the shelf launches apps and lists their windows
(the desktop has no rail to launch from), the launcher (⌘K) searches apps and
commands, the switcher (mod+\`) cycles windows. The old "no launcher on the
desktop, the dock lists windows only" rule is gone with the rail.

A window is a group of tabs (`FloatingWindow.members`, browser-style; any tab can
join any window, whatever its app). It is "of" the app of its **shown** tab: the
titlebar's app button, the shelf grouping, thumbnails and the overview label
all read that tab's app.

## Seamless vs classic titlebar — derived, never configured

The titlebar is seamless (the window's own background, no border) unless the
shown tab's app shell draws a sidebar, in which case it is classic (tinted, with
a bottom border — the mockup's `.has-side`). The fact comes from
`useSidebarDrawnOn(tabId)` (`primitives/app-shell`): every mounted
`AppShellLayout` that renders its `sidebarSlot` records itself against its
surface, so the bar follows what is on screen and an app that gains or loses a
sidebar needs no change here. There is no setting and no per-app flag.

## The overlay seam

`FloatingForeground` (the placement's `Foreground`, above every window) mounts:

- this plugin's own window cues, inside the desktop theme (`app:desktop`): the
  snap ghost, the tab-drag ghost / insertion mark / tear-off preview, and the
  overview's labels and click targets;
- every `Desktop.Overlay` contribution, each isolated, inside the same theme —
  the windows plugin names none of them (collection–consumer separation);
- two headless publishers: the tabs bridge (live tab order + focus / close /
  open, for the shortcuts and commands) and the desk frame (the backdrop's size,
  for the commands that lay windows out).

Cross-plugin channels the overlays use, all exported from the web barrel:
`setWorkAreaReserve` (below), `setMinimizeTargetResolver` (where a window
minimises to — the shelf entry; the motion falls back to a straight drop),
`setPeekedWindow` (raise one window over all and fade the rest — the shelf's
thumbnails), `toggleOverview` / `useOverviewActive`, `tileAllWindows`,
`minimizeAllWindows`, and `WindowSnapshot` (a hover snapshot of a window's DOM).

## The work area

Maximise, the snap tiles, the snap ghost, clamping and "tile all" lay out inside
the **work area**: the backdrop minus the strip the shelf keeps at the bottom
(`setWorkAreaReserve(px)` from the shelf, read reactively with
`useWorkAreaReserve`). `snapBox(zone, reserve)` is the CSS form (percent + calc,
so the box reflows on resize and transitions between free and snapped),
`snapRect(zone, w, h, reserve)` the pixel twin. Values are the mockup's: edge
band 10px, corner band `min(120, 20%` of the work-area height`)`, the very top
(≤ 2px) maximises, 6px gutter (`SNAP_GAP`), maximise fills the work area edge to
edge. A released free window is clamped back so 120px stays on screen sideways
and its titlebar above the bottom.

## Overview and peek

Both move windows without touching their boxes: the motion layer
(`use-window-motion`) reads them. The overview (F3, `desktop.overview`) lays the
active desktop's visible windows out in the mockup's `enterOverview` grid
(`internal/overview-layout.ts`, pure) and each window glides to its cell by
transform; a click picks a window, a click on the empty desktop or Esc leaves. A
peek raises the peeked window just under the desktop overlays and fades the
others to 7%.

## Virtual desktops (workspaces)

Floating placement supports **virtual desktops** (the macOS Spaces / GNOME
workspaces / Win11 desktops model) — purely a logical grouping of windows over
the one single surface. There is **no multi-monitor concept**; a desktop is just
a window grouping.

**Model.** Each {@link FloatingWindow} carries a top-level `desktopId` (a
window-organization property, NOT part of `Geometry`'s box/chrome). The store
({@link use-floating-windows}) owns an ordered `desktops: Desktop[]` +
`activeDesktopId`, both persisted in the same sessionStorage blob as the windows
map (`{ windows, desktops, activeDesktopId }`; legacy shapes without a `windows`
key migrate every window onto one freshly-minted default desktop). Ids mint
monotonically (`d1, d2, …`); a default `d1` is guaranteed to exist after
`hydrate()`. New windows mint on the active desktop. `useDesktops()` is the
reactive read; `createDesktop` / `removeDesktop` / `setActiveDesktop` /
`moveWindowToDesktop` / `topmostWindowOnDesktop` are the ops.

**Off-desktop = keep-alive `display:none`.** Switching desktops re-uses the
existing keep-alive "hidden" mechanism: a window off the active desktop stays
mounted but `display:none` (folded into `useFloatingWindowStyle`'s `hidden` via
the `onActiveDesktop` param), with **no** transition — it is not an animated
minimize, it simply isn't on this desktop. A switch is therefore instant with
zero remounts.

The window menu has a "Move to desktop ▸" submenu (current desktop checked, plus
"New desktop"); the shelf's tray holds the pager.

**Shortcuts** (page keys, collision-free with the `ctrl+alt+arrow` snap family):
`ctrl+alt+pagedown` / `ctrl+alt+pageup` switch to the next / previous desktop
(wrapping, focusing the top window); `ctrl+alt+shift+pagedown` / `…+pageup` move
the focused window to the next / previous desktop and follow it (moving past the
last desktop creates a new one; moving before the first clamps). `alt+n` opens a
new window of the focused window's app; F3 toggles the overview.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The desktop's windows: the floating-window surface placement (free, draggable/resizable windows over the wallpaper backdrop, inside the work area the shelf leaves), their tabbed titlebar and window menu, snapping, the overview, the shelf's peek, and the keyboard window-management shortcuts.
- Web:
  - Slots: `Desktop.Overlay`
  - Slot contributors:
    - `Desktop.Overlay` ← `apps.desktop.launcher`
    - `Desktop.Overlay` ← `apps.desktop.shelf`
    - `Desktop.Overlay` ← `apps.desktop.switcher`
  - Contributes:
    - `Surface.Placement`
    - `Shortcuts.Shortcut` "desktop.overview (f3)"
    - `Shortcuts.Shortcut` "desktop.overview-exit (escape)"
    - `Shortcuts.Shortcut` "floating.close (mod+w)"
    - `Shortcuts.Shortcut` "floating.desktop-next (ctrl+alt+pagedown)"
    - `Shortcuts.Shortcut` "floating.desktop-prev (ctrl+alt+pageup)"
    - `Shortcuts.Shortcut` "floating.minimize (mod+m)"
    - `Shortcuts.Shortcut` "floating.new-window (alt+n)"
    - `Shortcuts.Shortcut` "floating.snap-down (ctrl+alt+arrowdown)"
    - `Shortcuts.Shortcut` "floating.snap-left (ctrl+alt+arrowleft)"
    - `Shortcuts.Shortcut` "floating.snap-right (ctrl+alt+arrowright)"
    - `Shortcuts.Shortcut` "floating.snap-up (ctrl+alt+arrowup)"
    - `Shortcuts.Shortcut` "floating.toggle-pin (ctrl+alt+p)"
    - `Shortcuts.Shortcut` "floating.window-to-next-desktop (ctrl+alt+shift+pagedown)"
    - `Shortcuts.Shortcut` "floating.window-to-prev-desktop (ctrl+alt+shift+pageup)"
  - Uses: 44 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×8
    - `apps-core/surface` ×4
    - `apps/desktop/shell` ×3
    - `apps/desktop/wallpaper` ×3
    - `primitives/scope/app-instance` ×3
    - `primitives/shortcuts` ×3
    - `primitives/css/layer` ×2
    - `primitives/css/theme-boundary` ×2
    - `primitives/overlay/cursor-menu` ×2
    - `apps-core/app-icon.DEFAULT_APP_ICON`
    - `apps-core/tabs.useTabs`
    - `apps-core.Apps`
    - `config_v2.useConfig`
    - `primitives/app-shell.useSidebarDrawnOn`
    - `primitives/css/center.Center`
    - `primitives/css/clip.Clip`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/text.Text`
    - `primitives/scope/install-sink.defineInstallSink`
    - `primitives/slot-render.renderIsolated`
    - `ui/icons.Icon`
  - Exports (types):
    - `DesktopOverlayContribution`
    - `FloatingWindow`
    - `RectFraction`
    - `VirtualDesktop`
    - `WindowId`
  - Exports (values):
    - `bringWindowToFront`
    - `createDesktop`
    - `Desktop`
    - `DesktopWallpaper`
    - `getDesktopsState`
    - `getFloatingWindow`
    - `getWorkAreaReserve`
    - `minimizeAllWindows`
    - `moveWindowToDesktop`
    - `removeDesktop`
    - `restoreWindow`
    - `setActiveDesktop`
    - `setMinimizeTargetResolver`
    - `setPeekedWindow`
    - `setWorkAreaReserve`
    - `tileAllWindows`
    - `toggleOverview`
    - `toggleWindowPin`
    - `topmostWindowOnDesktop`
    - `useDesktops`
    - `useFloatingWindows`
    - `useOverviewActive`
    - `useWorkAreaReserve`
    - `windowForTab`
    - `windowRectFraction`
    - `WindowSnapshot`
- Cross-plugin:
  - Uses tokens: 23 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×13
    - `ui/tokens/type-scale` ×8
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/desktop/launcher`
    - `apps/desktop/shelf`
    - `apps/desktop/switcher`

<!-- AUTOGENERATED:END -->
