import { getFocusedSurfaceId } from "@plugins/primitives/plugins/shortcuts/web";
import type { FloatingWindow, WindowId } from "./hooks/use-floating-windows";
import {
  SNAP_GAP,
  snapRect,
  workAreaHeight,
  type Rect,
  type SnapDirection,
} from "./hooks/use-snap";
import { layoutOverview, layoutTiles } from "./internal/overview-layout";
import {
  peekFocusedDesktop,
  type DesktopRuntime,
} from "./internal/desktop-runtime";

/**
 * Imperative window-management commands, each acting on ONE desktop (`desk` —
 * the desktop of a tab set, see `internal/desktop-runtime`). The keyboard
 * shortcuts (registered in this plugin's barrel) run them on the desktop the
 * user is in ({@link onFocusedDesktop}); the shelf runs them on its own. The
 * focused window is resolved from the focused *surface* — `getFocusedSurfaceId()`
 * returns the focused tabId (the tab sets feed it into the shortcut system on
 * every focus change), which the desktop's store maps to the window holding it
 * (none when the focused tab is another tab set's).
 *
 * Cross-window commands (close, new window, focus) additionally need the live
 * floating tab order + focus/close/open callbacks, which the floating
 * Foreground's tabs bridge installs on the desktop (`desk.tabs()`). Every read
 * runs from a handler — after installation, re-sampled on every keypress.
 */

/** Run a command on the desktop the user is in (a shortcut's handler). */
export function onFocusedDesktop(run: (desk: DesktopRuntime) => void): void {
  const desk = peekFocusedDesktop();
  if (desk) run(desk);
}

/** The window currently holding the focused surface (the active member's tab). */
function focusedWindowId(desk: DesktopRuntime): string | undefined {
  const tabId = getFocusedSurfaceId();
  return tabId ? desk.windows.windowForTab(tabId) : undefined;
}

/** Tile the focused window in a direction (maximize/quarter/restore/minimize). */
export function snapFocusedWindow(desk: DesktopRuntime, dir: SnapDirection) {
  const wid = focusedWindowId(desk);
  if (wid) desk.windows.snapWindowDirection(wid, dir);
}

/** Minimize the focused window to the dock. */
export function minimizeFocusedWindow(desk: DesktopRuntime) {
  const wid = focusedWindowId(desk);
  if (wid) desk.windows.restoreWindow(wid, /* minimize */ true);
}

/** Toggle the focused window's always-on-top flag. */
export function togglePinFocusedWindow(desk: DesktopRuntime) {
  const wid = focusedWindowId(desk);
  if (wid) desk.windows.toggleWindowPin(wid);
}

/**
 * Close the focused tab (the active member). Browser-like: `mod+w` closes the
 * shown tab, not the whole window — the right-side titlebar X closes the window.
 */
export function closeFocusedWindow(desk: DesktopRuntime) {
  const tabId = getFocusedSurfaceId();
  const bridge = desk.tabs();
  if (tabId && bridge) bridge.closeTab(tabId);
}

/**
 * A new window of the focused window's app (mockup `⌥N`): a new tab of the app
 * its shown tab belongs to, which the desktop opens as a window of its own.
 */
export function openNewWindowOfFocusedApp(desk: DesktopRuntime) {
  const tabId = getFocusedSurfaceId();
  const bridge = desk.tabs();
  const appId = tabId && bridge ? bridge.appIdOf(tabId) : undefined;
  if (bridge && appId) bridge.openTab(appId);
}

/** Bring a window forward: un-minimise it, raise it, focus its shown tab. */
export function focusWindow(desk: DesktopRuntime, windowId: WindowId) {
  const win = desk.windows.getFloatingWindow(windowId);
  if (!win) return;
  desk.windows.restoreWindow(windowId);
  desk.windows.bringWindowToFront(windowId);
  desk.tabs()?.focusTab(win.activeTabId);
}

/** The windows a desktop shows right now — on the active desktop, not minimised. */
function visibleWindows(desk: DesktopRuntime): FloatingWindow[] {
  const { activeDesktopId } = desk.windows.getDesktopsState();
  const live = new Set(desk.tabs()?.tabIds ?? []);
  return [...desk.windows.getFloatingWindows().values()].filter(
    (w) =>
      w.desktopId === activeDesktopId &&
      !w.geo.minimized &&
      live.has(w.activeTabId),
  );
}

/** A window's current box in desktop pixels (a snapped one resolved to its tile). */
function windowBox(
  desk: DesktopRuntime,
  w: FloatingWindow,
  bounds: { width: number; height: number },
): Rect {
  return w.geo.snap
    ? snapRect(
        w.geo.snap,
        bounds.width,
        bounds.height,
        desk.getWorkAreaReserve(),
      )
    : { x: w.geo.x, y: w.geo.y, w: w.geo.w, h: w.geo.h };
}

/**
 * Open or close the overview (mockup F3): the active desktop's visible windows
 * glide into a grid, each labelled; a click picks one. Nothing to show → it
 * stays closed.
 */
export function toggleOverview(desk: DesktopRuntime) {
  if (desk.isOverviewOpen()) {
    desk.hideOverview();
    return;
  }
  const bounds = desk.deskBounds();
  if (!bounds) return;
  desk.showOverview(
    layoutOverview(
      visibleWindows(desk).map((w) => ({
        id: w.id,
        box: windowBox(desk, w, bounds),
      })),
      bounds.width,
      bounds.height,
    ),
  );
}

/** Close the overview, bringing `pick` forward when the user clicked a window. */
export function exitOverview(desk: DesktopRuntime, pick?: WindowId) {
  desk.hideOverview();
  if (pick) focusWindow(desk, pick);
}

/** Tile every visible window of the active desktop into a grid (mockup `tileAll`). */
export function tileAllWindows(desk: DesktopRuntime) {
  desk.hideOverview();
  const bounds = desk.deskBounds();
  if (!bounds) return;
  desk.windows.placeWindows(
    layoutTiles(
      visibleWindows(desk).map((w) => ({
        id: w.id,
        box: windowBox(desk, w, bounds),
      })),
      bounds.width,
      workAreaHeight(bounds.height, desk.getWorkAreaReserve()),
      SNAP_GAP,
    ),
  );
}

/** Minimise every window of the active desktop. */
export function minimizeAllWindows(desk: DesktopRuntime) {
  desk.hideOverview();
  desk.windows.minimizeWindows(visibleWindows(desk).map((w) => w.id));
}

/**
 * Per desktop: the windows the last "show desktop" hid, and on which virtual
 * desktop — what toggling it again brings back. Superseded by the next hide;
 * ignored on another virtual desktop.
 */
const shownDesktops = new WeakMap<
  DesktopRuntime,
  { desktopId: string; windowIds: WindowId[] }
>();

/**
 * Show the desktop, or bring its windows back (Windows' "Show desktop"): while
 * the active desktop has a visible window, minimise them all and remember
 * which; once it has none, restore the ones the last call hid (those still
 * minimised there — a window restored or moved meanwhile is left alone) and
 * focus the front one.
 */
export function toggleShowDesktop(desk: DesktopRuntime) {
  desk.hideOverview();
  const visible = visibleWindows(desk);
  const { activeDesktopId } = desk.windows.getDesktopsState();
  if (visible.length > 0) {
    const shown = {
      desktopId: activeDesktopId,
      windowIds: visible.map((w) => w.id),
    };
    shownDesktops.set(desk, shown);
    desk.windows.minimizeWindows(shown.windowIds);
    return;
  }
  const hidden = shownDesktops.get(desk);
  shownDesktops.delete(desk);
  if (hidden?.desktopId !== activeDesktopId) return;
  desk.windows.unminimizeWindows(
    hidden.windowIds.filter((id) => {
      const w = desk.windows.getFloatingWindow(id);
      return w?.desktopId === activeDesktopId && w.geo.minimized;
    }),
  );
  const top = desk.windows.topmostWindowOnDesktop(activeDesktopId);
  if (top) desk.tabs()?.focusTab(top.activeTabId);
}

/**
 * Switch to the next (`+1`) / previous (`-1`) virtual desktop in list order,
 * WRAPPING, then focus that desktop's topmost (highest-z, non-minimized) window
 * via the tabs bridge. An empty desktop simply gets no focus on switch.
 */
export function switchDesktopByDelta(desk: DesktopRuntime, step: 1 | -1) {
  const { desktops, activeDesktopId } = desk.windows.getDesktopsState();
  const n = desktops.length;
  if (n === 0) return;
  const from = Math.max(
    0,
    desktops.findIndex((d) => d.id === activeDesktopId),
  );
  const target = desktops[(((from + step) % n) + n) % n]!;
  if (target.id === activeDesktopId) return;
  desk.windows.setActiveDesktop(target.id);
  const top = desk.windows.topmostWindowOnDesktop(target.id);
  if (top) desk.tabs()?.focusTab(top.activeTabId);
}

/**
 * Move the focused window to the next (`+1`) / previous (`-1`) virtual desktop
 * and follow it (the macOS shift-move convention). Moving past the LAST desktop
 * creates a new one; moving before the FIRST is clamped (no-op). After the move
 * the target desktop becomes active, the moved window is raised, and its active
 * member is re-focused.
 */
export function moveFocusedWindowByDelta(desk: DesktopRuntime, step: 1 | -1) {
  const tabId = getFocusedSurfaceId();
  const windowId = tabId ? desk.windows.windowForTab(tabId) : undefined;
  if (!windowId) return;
  const win = desk.windows.getFloatingWindow(windowId);
  if (!win) return;
  const { desktops } = desk.windows.getDesktopsState();
  const currentIndex = desktops.findIndex((d) => d.id === win.desktopId);
  if (currentIndex === -1) return;
  const targetIndex = currentIndex + step;
  let targetId: string;
  if (step === 1 && targetIndex === desktops.length) {
    // Past the last desktop → spill into a freshly-created one (don't activate
    // here; setActiveDesktop below follows the window).
    targetId = desk.windows.createDesktop();
  } else if (step === -1 && targetIndex < 0) {
    return; // Clamp: nothing before the first desktop.
  } else {
    targetId = desktops[targetIndex]!.id;
  }
  desk.windows.moveWindowToDesktop(windowId, targetId);
  desk.windows.setActiveDesktop(targetId);
  desk.windows.bringWindowToFront(windowId);
  desk.tabs()?.focusTab(win.activeTabId);
}
