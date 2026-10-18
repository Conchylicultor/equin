import { useMemo } from "react";
import { Apps, isTabApp, type ActiveApp } from "@plugins/apps-core/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import {
  bringWindowToFront,
  restoreWindow,
  useDesktops,
  useFloatingWindows,
  windowForTab,
  type FloatingWindow,
  type WindowId,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { shelfConfig } from "@plugins/apps/plugins/desktop/plugins/shell/core";
import {
  shelfEntries,
  type ShelfEntry,
  type ShelfWindow,
  type WindowAction,
} from "./shelf-model";

/** A shelf entry resolved against the installed app it stands for. */
export interface ShelfAppEntry extends ShelfEntry {
  app: ActiveApp;
  pinned: boolean;
}

/** Everything the shelf draws, read from the live tabs, windows and config. */
export interface ShelfModel {
  entries: ShelfAppEntry[];
  /** The window holding the focused tab, unless it is minimised or elsewhere. */
  focusedWindowId: WindowId | null;
  /** Every window on every desktop, by id. */
  windows: Map<WindowId, FloatingWindow>;
  /** The app a window is filed under: its active tab's app. */
  appOf: (w: FloatingWindow) => ActiveApp | undefined;
  /** A window's title: its active tab's content title, else its app's name. */
  titleOf: (w: FloatingWindow) => string;
}

/**
 * The shelf's model for the active desktop. `tabIds` are the live desktop tabs
 * in tab order, which is the order their windows were opened in — so walking
 * them (deduped by window) yields the windows in first-open order.
 */
export function useShelfModel(tabIds: string[]): ShelfModel {
  const { tabs, titles, focusedTabId } = useTabs();
  const windows = useFloatingWindows();
  const { activeDesktopId } = useDesktops();
  const contributions = Apps.App.useContributions();
  const { pinnedApps } = useConfig(shelfConfig);

  return useMemo(() => {
    const apps = new Map<string, ActiveApp>();
    for (const entry of contributions)
      if (isTabApp(entry)) apps.set(entry.id, entry);
    const appIdOfTab = new Map(tabs.map((t) => [t.tabId, t.appId]));
    const appOf = (w: FloatingWindow) => {
      const appId = appIdOfTab.get(w.activeTabId);
      return appId === undefined ? undefined : apps.get(appId);
    };
    const titleOf = (w: FloatingWindow) =>
      titles[w.activeTabId] ?? appOf(w)?.app.name ?? "Window";

    const seen = new Set<WindowId>();
    const onDesktop: ShelfWindow[] = [];
    for (const tabId of tabIds) {
      const id = windowForTab(tabId);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const w = windows.get(id);
      if (!w || w.desktopId !== activeDesktopId) continue;
      const appId = appIdOfTab.get(w.activeTabId);
      if (appId === undefined) continue;
      onDesktop.push({ id, appId, minimized: w.geo.minimized, z: w.geo.z });
    }

    const focusedId =
      focusedTabId === undefined ? undefined : windowForTab(focusedTabId);
    const focused =
      focusedId === undefined ? undefined : windows.get(focusedId);
    const focusedWindowId =
      focused && !focused.geo.minimized && focused.desktopId === activeDesktopId
        ? focused.id
        : null;

    const pinnedSet = new Set(pinnedApps);
    const entries = shelfEntries(
      pinnedApps,
      onDesktop,
      new Set(apps.keys()),
    ).map((e): ShelfAppEntry => ({
      ...e,
      app: apps.get(e.appId)!,
      pinned: pinnedSet.has(e.appId),
    }));
    return { entries, focusedWindowId, windows, appOf, titleOf };
  }, [
    contributions,
    tabs,
    titles,
    focusedTabId,
    windows,
    activeDesktopId,
    pinnedApps,
    tabIds,
  ]);
}

/** What the shelf does to apps and windows. */
export interface ShelfActions {
  /** A new window of the app (in desktop mode a new tab is a new window). */
  openWindow: (appId: string) => void;
  /** Bring a window forward, restore it, or minimise it. */
  runWindowAction: (action: WindowAction) => void;
  /** Close a window: every tab in it. */
  closeWindow: (windowId: WindowId) => void;
  /** Keep an app in the dock, or remove it. */
  togglePinned: (appId: string) => void;
}

export function useShelfActions(): ShelfActions {
  const { openTab, focusTab, closeTab } = useTabs();
  const windows = useFloatingWindows();
  const { pinnedApps } = useConfig(shelfConfig);
  const setConfig = useSetConfig(shelfConfig);

  return {
    openWindow: (appId) => {
      openTab(appId);
    },
    runWindowAction: (action) => {
      const w = windows.get(action.windowId);
      if (!w) return;
      if (action.kind === "minimize") {
        restoreWindow(w.id, /* minimize */ true);
        return;
      }
      restoreWindow(w.id);
      bringWindowToFront(w.id);
      focusTab(w.activeTabId);
    },
    closeWindow: (windowId) => {
      // Closing the last tab empties the window; the windows plugin prunes it.
      for (const tabId of windows.get(windowId)?.members ?? []) closeTab(tabId);
    },
    togglePinned: (appId) => {
      setConfig(
        "pinnedApps",
        pinnedApps.includes(appId)
          ? pinnedApps.filter((id) => id !== appId)
          : [...pinnedApps, appId],
      );
    },
  };
}
