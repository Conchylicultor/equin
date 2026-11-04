import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { peekDesktopActive } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import { Surface } from "@plugins/apps-core/plugins/surface/web";
import { defineShortcut } from "@plugins/primitives/plugins/shortcuts/web";
import { floatingDef } from "./floating-placement";
import {
  closeFocusedWindow,
  minimizeFocusedWindow,
  openNewWindowOfFocusedApp,
  toggleOverview,
  exitOverview,
  moveFocusedWindowByDelta,
  snapFocusedWindow,
  switchDesktopByDelta,
  togglePinFocusedWindow,
  onFocusedDesktop,
} from "./window-commands";
import { Desktop } from "./slots";
import { peekFocusedDesktop } from "./internal/desktop-runtime";

export { Desktop, type DesktopOverlayContribution } from "./slots";
export {
  useFloatingWindows,
  useDesktops,
  type FloatingWindow,
  type Desktop as VirtualDesktop,
  type WindowId,
} from "./hooks/use-floating-windows";
export {
  defineDesktopSink,
  useDesktop,
  useWorkAreaReserve,
  useOverviewActive,
  type DesktopRuntime,
} from "./internal/desktop-runtime";
export {
  onFocusedDesktop,
  toggleOverview,
  tileAllWindows,
  minimizeAllWindows,
  toggleShowDesktop,
} from "./window-commands";
export { WindowSnapshot } from "./components/window-snapshot";
export {
  windowRectFraction,
  type RectFraction,
} from "./components/minimap-geometry";
export { DesktopWallpaper } from "./components/desktop-wallpaper";

export default {
  description:
    "The desktop's windows: the floating-window surface placement (free, draggable/resizable windows over the wallpaper backdrop, inside the work area the shelf leaves), their tabbed titlebar and window menu, snapping, the overview, the shelf's peek, and the keyboard window-management shortcuts.",
  slots: Desktop,
  contributions: [
    Surface.Placement(floatingDef),
    // Keyboard window management — eligible only while the desktop is the
    // surface mode. Tiling uses the Ctrl+Alt window-manager modifier (free on
    // macOS, the primary target); minimize/close use the platform `mod` so they
    // read as ⌘M / ⌘W on Mac. Switching windows (mod+`) is the switcher's.
    defineShortcut({
      id: "floating.snap-left",
      keys: "ctrl+alt+arrowleft",
      label: "Tile window left",
      group: "Window",
      when: peekDesktopActive,
      handler: () =>
        onFocusedDesktop((desk) => snapFocusedWindow(desk, "left")),
    }),
    defineShortcut({
      id: "floating.snap-right",
      keys: "ctrl+alt+arrowright",
      label: "Tile window right",
      group: "Window",
      when: peekDesktopActive,
      handler: () =>
        onFocusedDesktop((desk) => snapFocusedWindow(desk, "right")),
    }),
    defineShortcut({
      id: "floating.snap-up",
      keys: "ctrl+alt+arrowup",
      label: "Maximize / tile window up",
      group: "Window",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop((desk) => snapFocusedWindow(desk, "up")),
    }),
    defineShortcut({
      id: "floating.snap-down",
      keys: "ctrl+alt+arrowdown",
      label: "Restore / minimize window",
      group: "Window",
      when: peekDesktopActive,
      handler: () =>
        onFocusedDesktop((desk) => snapFocusedWindow(desk, "down")),
    }),
    defineShortcut({
      id: "floating.minimize",
      keys: "mod+m",
      label: "Minimize window",
      group: "Window",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop(minimizeFocusedWindow),
    }),
    // Always-on-top toggle: uses the Ctrl+Alt window-manager modifier family (like
    // the tiling shortcuts), keeping the platform `mod` free for app shortcuts.
    defineShortcut({
      id: "floating.toggle-pin",
      keys: "ctrl+alt+p",
      label: "Toggle always on top",
      group: "Window",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop(togglePinFocusedWindow),
    }),
    defineShortcut({
      id: "floating.close",
      keys: "mod+w",
      label: "Close window",
      group: "Window",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop(closeFocusedWindow),
    }),
    // A new window of the focused window's app (mockup ⌥N).
    defineShortcut({
      id: "floating.new-window",
      keys: "alt+n",
      label: "New window",
      group: "Window",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop(openNewWindowOfFocusedApp),
    }),
    defineShortcut({
      id: "desktop.overview",
      keys: "f3",
      label: "Show overview",
      group: "Desktop",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop(toggleOverview),
    }),
    // Esc leaves the overview — eligible only while it is open.
    defineShortcut({
      id: "desktop.overview-exit",
      keys: "escape",
      label: "Leave overview",
      group: "Desktop",
      when: () =>
        peekDesktopActive() && !!peekFocusedDesktop()?.isOverviewOpen(),
      handler: () => onFocusedDesktop((desk) => exitOverview(desk)),
    }),
    // Virtual-desktop (workspace) navigation. Page keys keep the Ctrl+Alt
    // window-manager modifier family but stay collision-free with the
    // Ctrl+Alt+arrow snap shortcuts; Shift moves the focused window across.
    defineShortcut({
      id: "floating.desktop-next",
      keys: "ctrl+alt+pagedown",
      label: "Next desktop",
      group: "Window",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop((desk) => switchDesktopByDelta(desk, 1)),
    }),
    defineShortcut({
      id: "floating.desktop-prev",
      keys: "ctrl+alt+pageup",
      label: "Previous desktop",
      group: "Window",
      when: peekDesktopActive,
      handler: () => onFocusedDesktop((desk) => switchDesktopByDelta(desk, -1)),
    }),
    defineShortcut({
      id: "floating.window-to-next-desktop",
      keys: "ctrl+alt+shift+pagedown",
      label: "Move window to next desktop",
      group: "Window",
      when: peekDesktopActive,
      handler: () =>
        onFocusedDesktop((desk) => moveFocusedWindowByDelta(desk, 1)),
    }),
    defineShortcut({
      id: "floating.window-to-prev-desktop",
      keys: "ctrl+alt+shift+pageup",
      label: "Move window to previous desktop",
      group: "Window",
      when: peekDesktopActive,
      handler: () =>
        onFocusedDesktop((desk) => moveFocusedWindowByDelta(desk, -1)),
    }),
  ],
} satisfies PluginDefinition;
