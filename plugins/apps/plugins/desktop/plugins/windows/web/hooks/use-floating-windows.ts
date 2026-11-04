import { useCallback, useSyncExternalStore } from "react";
import { useDesktop } from "../internal/desktop-runtime";
import type {
  Desktop,
  FloatingWindow,
  GeometryUpdater,
  WindowId,
} from "../internal/window-store";

export {
  MIN_W,
  MIN_H,
  clampToBounds,
  type Bounds,
  type Desktop,
  type FloatingWindow,
  type Geometry,
  type GeometryUpdater,
  type WindowId,
} from "../internal/window-store";

/**
 * Reactive read of the virtual-desktop layout (pager / chrome) of the desktop
 * this component is in. Returns the store's desktop snapshot — a stable
 * reference between mutations, so `useSyncExternalStore` never sees a phantom
 * change. Hydrates on first read so the default desktop exists before first
 * paint (mirrors {@link useTabWindow}).
 */
export function useDesktops(): {
  desktops: Desktop[];
  activeDesktopId: string;
} {
  const { windows } = useDesktop();
  return useSyncExternalStore(
    windows.subscribe,
    windows.readDesktopSnapshot,
    windows.readDesktopSnapshot,
  );
}

/**
 * Reactive read of the whole windows map (for the dock) of the desktop this
 * component is in — a stable reference between mutations.
 */
export function useFloatingWindows(): Map<WindowId, FloatingWindow> {
  const { windows } = useDesktop();
  return useSyncExternalStore(
    windows.subscribe,
    windows.readSnapshot,
    windows.readSnapshot,
  );
}

/** The reactive window handle a {@link useTabWindow} reader receives. */
export interface TabWindowHandle {
  /** The window currently holding this tab (auto-created on first read). */
  window: FloatingWindow;
  /** Whether this tab is the window's shown member. */
  isActive: boolean;
  /** Mutate this window's geometry box (value or functional updater). */
  setGeo: (next: GeometryUpdater) => void;
  /** Raise this window above its tier-mates. */
  bringToFront: () => void;
}

/**
 * Per-tab window handle: resolves (and auto-creates) the window holding
 * `tabId`, exposing its geometry setter and a raise-to-front. `isActive` is
 * `window.activeTabId === tabId`, so an inactive group member can hide itself
 * while staying mounted. Every mutation persists (the page's desktop) and
 * notifies subscribers.
 */
export function useTabWindow(tabId: string): TabWindowHandle {
  const { windows } = useDesktop();
  const read = useCallback(
    () => windows.readWindowForTab(tabId),
    [windows, tabId],
  );
  const window = useSyncExternalStore(windows.subscribe, read, read);

  // Stable callbacks (keyed on the store and tabId): consumers push these into
  // effect deps / state, so an unstable identity per render would loop. `setGeo`
  // resolves the window by tab at call time, so it stays correct even if the tab
  // is later merged into a different window.
  const setGeo = useCallback(
    (next: GeometryUpdater) => windows.setTabGeo(tabId, next),
    [windows, tabId],
  );
  const bringToFront = useCallback(
    () => windows.bringTabToFront(tabId),
    [windows, tabId],
  );

  return {
    window,
    isActive: window.activeTabId === tabId,
    setGeo,
    bringToFront,
  };
}
