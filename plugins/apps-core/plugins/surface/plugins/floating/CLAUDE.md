# floating

## Design: the desktop is a calm backdrop (wallpaper + a context menu)

Floating placement is "desktop mode" — windows over a wallpaper. The backdrop
({@link DesktopBackdrop}) composes the wallpaper itself ({@link DesktopWallpaper}
— a full-bleed configurable image, or the default theme-driven gradient SVG),
the desktop right-click {@link DesktopContextMenu}, and the corner
{@link WallpaperAttribution} credit. The wallpaper layer stays
`pointer-events-none` + `aria-hidden`; a **left-click** on the empty desktop
still does nothing. What the desktop now supports (an intentional, documented
revision of the old "passive backdrop, no context menus" invariant) is exactly
two things:

- **A configurable wallpaper image.** Right-click → "Change wallpaper…" opens a
  picker sourcing images from a pluggable provider registry (Openverse search,
  upload, paste-URL — see `plugins/wallpaper/`). The choice persists **globally**
  (`wallpaperConfig`, no `scope: "app"`): the floating desktop renders against the
  global `:root` theme, so the wallpaper is a property of the desktop itself, one
  setting shared across apps and worktrees. Images are mirrored locally and served
  same-origin; config holds only metadata + CC-BY attribution.
- **A desktop context menu.** A transparent capture layer in the **backdrop**
  (below windows, so a right-click on a window still hits that window's own system
  menu — only the empty desktop reaches the desktop menu) offers "Change
  wallpaper…" and "Reset to default".

Still OFF the desktop, deliberately: **no desktop icons, shortcuts,
drag-to-create, or app launcher**. The context menu is a wallpaper affordance, not
a launcher surface.

Why no desktop icons/launcher here:

- **One home for launching, not two.** App launching and switching are owned by
  the **app-rail** and the **Home app** (`@plugins/apps/plugins/home`, the
  launcher grid). Duplicating that as desktop shortcuts would split the model and
  drift. If you reach for "put a launcher / shortcut on the desktop," the answer
  is to send the user to Home / the app-rail instead.
- **The bottom dock is a *window* taskbar, not an app launcher.** {@link WindowDock}
  shows one chip per **open floating window** (restore / minimize targets) on the
  active virtual desktop, in tab order, and hosts the per-desktop **workspace
  pager** ({@link WorkspacePager}) on its left. It never lists apps you could
  launch — only windows that already exist, and desktops that organize them.
  Don't grow it into a launcher.
- **Passive keeps focus-depth legible.** The backdrop dims behind the elevated
  active window; interactive desktop chrome would compete with that and muddy the
  "the desktop is calm, the window is the subject" read.

For future work: anything launcher- or icon-shaped belongs in Home / the app-rail,
behind their existing slots — never painted onto this backdrop. New desktop
affordances beyond the wallpaper + its context menu need the same scrutiny: the
desktop stays calm, the window stays the subject.

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
zero remounts. The dock's window chips and the `mod+\`` cycle are filtered to the
active desktop.

**UX (all chrome, never the wallpaper).** The {@link WorkspacePager} — a compact
row of numbered pills — sits on the **left** of the dock bar, separated from the
window chips by a thin divider (one cohesive bottom shelf; the dock always
renders while the Foreground is mounted, even on an empty desktop). Click a pill
to switch + focus that desktop's topmost window; the trailing `+` creates and
switches to a new desktop; a hover-revealed `×` removes a desktop (never the
last). The window system menu has a "Move to desktop ▸" submenu (current desktop
checked + disabled, plus "New desktop"). This does **not** violate the
passive-backdrop invariant above: the pager is *chrome* (it lives in the dock,
organizing windows), not desktop icons painted on the wallpaper, and it is not an
app launcher.

**Shortcuts** (page keys, collision-free with the `ctrl+alt+arrow` snap family):
`ctrl+alt+pagedown` / `ctrl+alt+pageup` switch to the next / previous desktop
(wrapping, focusing the top window); `ctrl+alt+shift+pagedown` / `…+pageup` move
the focused window to the next / previous desktop and follow it (moving past the
last desktop creates a new one; moving before the first clamps).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Floating-window surface placement: a free-floating, draggable/resizable window over a desktop wallpaper backdrop. Owns the per-tab geometry store, window chrome, and keyboard window-management shortcuts (tile / minimize / close / cycle).
- Web:
  - Contributes:
    - `Surface.Placement`
    - `ConfigV2.WebRegister` "floating-chrome"
    - `ThemeEngine.VariantGroup` "Window titlebar" → `TitlebarStylePicker`
    - `Shortcuts.Shortcut` "floating.close (mod+w)"
    - `Shortcuts.Shortcut` "floating.cycle-next (mod+`)"
    - `Shortcuts.Shortcut` "floating.cycle-prev (mod+shift+~)"
    - `Shortcuts.Shortcut` "floating.cycle-prev-backquote (mod+shift+`)"
    - `Shortcuts.Shortcut` "floating.desktop-next (ctrl+alt+pagedown)"
    - `Shortcuts.Shortcut` "floating.desktop-prev (ctrl+alt+pageup)"
    - `Shortcuts.Shortcut` "floating.minimize (mod+m)"
    - `Shortcuts.Shortcut` "floating.snap-down (ctrl+alt+arrowdown)"
    - `Shortcuts.Shortcut` "floating.snap-left (ctrl+alt+arrowleft)"
    - `Shortcuts.Shortcut` "floating.snap-right (ctrl+alt+arrowright)"
    - `Shortcuts.Shortcut` "floating.snap-up (ctrl+alt+arrowup)"
    - `Shortcuts.Shortcut` "floating.toggle-pin (ctrl+alt+p)"
    - `Shortcuts.Shortcut` "floating.window-to-next-desktop (ctrl+alt+shift+pagedown)"
    - `Shortcuts.Shortcut` "floating.window-to-prev-desktop (ctrl+alt+shift+pageup)"
  - Uses: 54 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×10
    - `apps-core/surface` ×4
    - `apps-core/tabs` ×3
    - `config_v2` ×3
    - `primitives/scope/app-instance` ×3
    - `primitives/shortcuts` ×3
    - `apps-core/app-icon` ×2
    - `apps-core/surface/floating/wallpaper` ×2
    - `primitives/css/layer` ×2
    - `primitives/css/spacing` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/overlay/cursor-menu` ×2
    - `ui/tab-bar` ×2
    - `ui/theme-engine` ×2
    - `apps-core.Apps`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.ToggleChip`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/scope/install-sink.defineInstallSink`
    - `ui/icons.Icon`
- Server:
  - Contributes: `ConfigV2.Register` "floating-chrome"
  - Uses: `config_v2.ConfigV2`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
  - Exports (values): `floatingChromeConfig`
- Cross-plugin:
  - Uses tokens: 23 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×8
    - `ui/tokens/density` ×5
    - `ui/tokens/shadow` ×4
    - `ui/tokens/type-scale` ×4
    - `ui/tokens/shape` ×2
- Sub-plugins:
  - **`wallpaper`** — Floating desktop wallpaper: the Wallpaper.Provider source registry, the picker dialog + shared search panel, the desktop right-click context menu, the corner attribution credit, and the global…

<!-- AUTOGENERATED:END -->
