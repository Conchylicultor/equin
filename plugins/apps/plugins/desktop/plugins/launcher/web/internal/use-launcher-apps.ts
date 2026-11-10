import { useMemo } from "react";
import { isTabApp, useListedApps } from "@plugins/apps-core/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";
import {
  useDesktop,
  useDesktops,
  useFloatingWindows,
  type FloatingWindow,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { windowsByApp } from "./launcher-model";

/** An app the launcher can open, with how many windows it has on this desktop. */
export interface LauncherApp {
  id: string;
  name: string;
  icon: AppIcon;
  /** Windows of this app on the active desktop (a window is of its active tab's app). */
  windows: number;
}

/**
 * Every launchable app — the apps that open in a tab, so not the desktop's own
 * surface-mode entry — in the order the app rail shows them (the `Apps.App`
 * slot's reorder layout, hidden and unlisted apps left out — `useListedApps`), each with its window count on
 * the active desktop.
 */
export function useLauncherApps(): ResourceResult<LauncherApp[]> {
  const listed = useListedApps();
  const counts = useWindowsOfApp();
  return useMemo(
    () =>
      mapResource(listed, (apps) =>
        apps.filter(isTabApp).map((a) => ({
          id: a.id,
          name: a.app.name,
          icon: a.icon,
          windows: counts.get(a.id)?.length ?? 0,
        })),
      ),
    [listed, counts],
  );
}

/** The active desktop's windows per app, front-most first. */
function useWindowsOfApp(): Map<string, FloatingWindow[]> {
  const { tabs } = useTabs();
  const windows = useFloatingWindows();
  const { activeDesktopId } = useDesktops();
  return useMemo(
    () =>
      windowsByApp(
        windows.values(),
        activeDesktopId,
        new Map(tabs.map((t) => [t.tabId, t.appId])),
      ),
    [tabs, windows, activeDesktopId],
  );
}

/**
 * What picking an app does. `activate` brings the app's front-most window on
 * this desktop forward (restoring it if minimised) and opens the app when it
 * has none; `newWindow` always opens a new tab of it, which on the desktop is a
 * new window.
 */
export function useAppActions(): {
  activate(appId: string): void;
  newWindow(appId: string): void;
} {
  const { openTab, focusTab } = useTabs();
  const desk = useDesktop();
  const byApp = useWindowsOfApp();
  return {
    activate(appId) {
      const front = byApp.get(appId)?.[0];
      if (!front) {
        openTab(appId);
        return;
      }
      if (front.geo.minimized) desk.windows.restoreWindow(front.id);
      desk.windows.bringWindowToFront(front.id);
      focusTab(front.activeTabId);
    },
    newWindow(appId) {
      openTab(appId);
    },
  };
}
