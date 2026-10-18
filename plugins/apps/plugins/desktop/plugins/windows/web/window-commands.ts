import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import { getFocusedSurfaceId } from "@plugins/primitives/plugins/shortcuts/web";
import {
  bringWindowToFront,
  createDesktop,
  getDesktopsState,
  getFloatingWindow,
  getFloatingWindows,
  minimizeWindows,
  moveWindowToDesktop,
  placeWindows,
  restoreWindow,
  setActiveDesktop,
  snapWindowDirection,
  toggleWindowPin,
  topmostWindowOnDesktop,
  unminimizeWindows,
  windowForTab,
  type FloatingWindow,
  type WindowId,
} from "./hooks/use-floating-windows";
import {
  SNAP_GAP,
  snapRect,
  workAreaHeight,
  type Rect,
  type SnapDirection,
} from "./hooks/use-snap";
import { peekDeskBounds } from "./internal/desk-bounds";
import { getWorkAreaReserve } from "./internal/work-area";
import { layoutOverview, layoutTiles } from "./internal/overview-layout";
import {
  hideOverview,
  isOverviewOpen,
  showOverview,
} from "./internal/overview";

/**
 * Imperative window-management commands driven by the static keyboard shortcuts
 * (registered in this plugin's barrel). The focused window is resolved from the
 * focused *surface* — `getFocusedSurfaceId()` returns the focused tabId (the apps
 * tab model feeds it into the shortcut system on every focus change), which
 * {@link windowForTab} maps to the window currently holding it — so snap /
 * minimize / pin need no window handle and read it directly.
 *
 * Cross-window commands (close, new window, focus) additionally need the live
 * floating tab order + focus/close/open callbacks. The load-bearing `apps` plugin exposes those
 * only through the `useTabs()` hook, so a tiny in-tree publisher (the
 * {@link floatingTabsBridgeSink} install sink, filled from the floating
 * Foreground) bridges them to module scope. There is never more than one
 * floating surface in focus, so a single page-global slot is the right shape.
 * Every read below runs from a keyboard-shortcut handler — after installation,
 * and re-sampled on every keypress — so `peek()` is the correct read.
 */
export interface FloatingTabsBridge {
  /** Open floating tabIds, in tab-strip order. */
  tabIds: string[];
  focusTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  /** Open a new tab of `appId` — on the desktop, a new window. */
  openTab: (appId: string) => string;
  /** The app a live tab shows (undefined for an unknown tab). */
  appIdOf: (tabId: string) => string | undefined;
}

/** The live tabs bridge, installed by `FloatingTabsBridge` while a floating window exists. */
export const floatingTabsBridgeSink = defineInstallSink<FloatingTabsBridge>({
  name: "floating.tabs-bridge",
  what: "the floating tab order + focus/close/open callbacks (installed by the floating Foreground's FloatingTabsBridge)",
});

/** The window currently holding the focused surface (the active member's tab). */
function focusedWindowId(): string | undefined {
  const tabId = getFocusedSurfaceId();
  return tabId ? windowForTab(tabId) : undefined;
}

/** Tile the focused window in a direction (maximize/quarter/restore/minimize). */
export function snapFocusedWindow(dir: SnapDirection) {
  const wid = focusedWindowId();
  if (wid) snapWindowDirection(wid, dir);
}

/** Minimize the focused window to the dock. */
export function minimizeFocusedWindow() {
  const wid = focusedWindowId();
  if (wid) restoreWindow(wid, /* minimize */ true);
}

/** Toggle the focused window's always-on-top flag. */
export function togglePinFocusedWindow() {
  const wid = focusedWindowId();
  if (wid) toggleWindowPin(wid);
}

/**
 * Close the focused tab (the active member). Browser-like: `mod+w` closes the
 * shown tab, not the whole window — the right-side titlebar X closes the window.
 */
export function closeFocusedWindow() {
  const tabId = getFocusedSurfaceId();
  const bridge = floatingTabsBridgeSink.peek();
  if (tabId && bridge) bridge.closeTab(tabId);
}

/**
 * A new window of the focused window's app (mockup `⌥N`): a new tab of the app
 * its shown tab belongs to, which the desktop opens as a window of its own.
 */
export function openNewWindowOfFocusedApp() {
  const tabId = getFocusedSurfaceId();
  const bridge = floatingTabsBridgeSink.peek();
  const appId = tabId && bridge ? bridge.appIdOf(tabId) : undefined;
  if (bridge && appId) bridge.openTab(appId);
}

/** Bring a window forward: un-minimise it, raise it, focus its shown tab. */
export function focusWindow(windowId: WindowId) {
  const win = getFloatingWindow(windowId);
  if (!win) return;
  restoreWindow(windowId);
  bringWindowToFront(windowId);
  floatingTabsBridgeSink.peek()?.focusTab(win.activeTabId);
}

/** The windows a desktop shows right now — on the active desktop, not minimised. */
function visibleWindows(): FloatingWindow[] {
  const { activeDesktopId } = getDesktopsState();
  const live = new Set(floatingTabsBridgeSink.peek()?.tabIds ?? []);
  return [...getFloatingWindows().values()].filter(
    (w) =>
      w.desktopId === activeDesktopId &&
      !w.geo.minimized &&
      live.has(w.activeTabId),
  );
}

/** A window's current box in desktop pixels (a snapped one resolved to its tile). */
function windowBox(
  w: FloatingWindow,
  bounds: { width: number; height: number },
): Rect {
  return w.geo.snap
    ? snapRect(w.geo.snap, bounds.width, bounds.height, getWorkAreaReserve())
    : { x: w.geo.x, y: w.geo.y, w: w.geo.w, h: w.geo.h };
}

/**
 * Open or close the overview (mockup F3): the active desktop's visible windows
 * glide into a grid, each labelled; a click picks one. Nothing to show → it
 * stays closed.
 */
export function toggleOverview() {
  if (isOverviewOpen()) {
    hideOverview();
    return;
  }
  const bounds = peekDeskBounds();
  if (!bounds) return;
  showOverview(
    layoutOverview(
      visibleWindows().map((w) => ({ id: w.id, box: windowBox(w, bounds) })),
      bounds.width,
      bounds.height,
    ),
  );
}

/** Close the overview, bringing `pick` forward when the user clicked a window. */
export function exitOverview(pick?: WindowId) {
  hideOverview();
  if (pick) focusWindow(pick);
}

/** Tile every visible window of the active desktop into a grid (mockup `tileAll`). */
export function tileAllWindows() {
  hideOverview();
  const bounds = peekDeskBounds();
  if (!bounds) return;
  placeWindows(
    layoutTiles(
      visibleWindows().map((w) => ({ id: w.id, box: windowBox(w, bounds) })),
      bounds.width,
      workAreaHeight(bounds.height, getWorkAreaReserve()),
      SNAP_GAP,
    ),
  );
}

/** Minimise every window of the active desktop. */
export function minimizeAllWindows() {
  hideOverview();
  minimizeWindows(visibleWindows().map((w) => w.id));
}

/**
 * The windows the last "show desktop" hid, and on which desktop — what toggling
 * it again brings back. Superseded by the next hide; ignored on another desktop.
 */
let shownDesktop: { desktopId: string; windowIds: WindowId[] } | null = null;

/**
 * Show the desktop, or bring its windows back (Windows' "Show desktop"): while
 * the active desktop has a visible window, minimise them all and remember
 * which; once it has none, restore the ones the last call hid (those still
 * minimised there — a window restored or moved meanwhile is left alone) and
 * focus the front one.
 */
export function toggleShowDesktop() {
  hideOverview();
  const visible = visibleWindows();
  const { activeDesktopId } = getDesktopsState();
  if (visible.length > 0) {
    shownDesktop = {
      desktopId: activeDesktopId,
      windowIds: visible.map((w) => w.id),
    };
    minimizeWindows(shownDesktop.windowIds);
    return;
  }
  const hidden = shownDesktop;
  shownDesktop = null;
  if (hidden?.desktopId !== activeDesktopId) return;
  unminimizeWindows(
    hidden.windowIds.filter((id) => {
      const w = getFloatingWindow(id);
      return w?.desktopId === activeDesktopId && w.geo.minimized;
    }),
  );
  const top = topmostWindowOnDesktop(activeDesktopId);
  if (top) floatingTabsBridgeSink.peek()?.focusTab(top.activeTabId);
}

/**
 * Switch to the next (`+1`) / previous (`-1`) virtual desktop in list order,
 * WRAPPING, then focus that desktop's topmost (highest-z, non-minimized) window
 * via the tabs bridge. An empty desktop simply gets no focus on switch.
 */
export function switchDesktopByDelta(step: 1 | -1) {
  const { desktops, activeDesktopId } = getDesktopsState();
  const n = desktops.length;
  if (n === 0) return;
  const from = Math.max(
    0,
    desktops.findIndex((d) => d.id === activeDesktopId),
  );
  const target = desktops[(((from + step) % n) + n) % n]!;
  if (target.id === activeDesktopId) return;
  setActiveDesktop(target.id);
  const top = topmostWindowOnDesktop(target.id);
  if (top) floatingTabsBridgeSink.peek()?.focusTab(top.activeTabId);
}

/**
 * Move the focused window to the next (`+1`) / previous (`-1`) virtual desktop
 * and follow it (the macOS shift-move convention). Moving past the LAST desktop
 * creates a new one; moving before the FIRST is clamped (no-op). After the move
 * the target desktop becomes active, the moved window is raised, and its active
 * member is re-focused.
 */
export function moveFocusedWindowByDelta(step: 1 | -1) {
  const tabId = getFocusedSurfaceId();
  const windowId = tabId ? windowForTab(tabId) : undefined;
  if (!windowId) return;
  const win = getFloatingWindow(windowId);
  if (!win) return;
  const { desktops } = getDesktopsState();
  const currentIndex = desktops.findIndex((d) => d.id === win.desktopId);
  if (currentIndex === -1) return;
  const targetIndex = currentIndex + step;
  let targetId: string;
  if (step === 1 && targetIndex === desktops.length) {
    // Past the last desktop → spill into a freshly-created one (don't activate
    // here; setActiveDesktop below follows the window).
    targetId = createDesktop();
  } else if (step === -1 && targetIndex < 0) {
    return; // Clamp: nothing before the first desktop.
  } else {
    targetId = desktops[targetIndex]!.id;
  }
  moveWindowToDesktop(windowId, targetId);
  setActiveDesktop(targetId);
  bringWindowToFront(windowId);
  floatingTabsBridgeSink.peek()?.focusTab(win.activeTabId);
}
