import { useMemo } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { Apps, isTabApp } from "@plugins/apps-core/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { isNodeData, useReorderedEntries } from "@plugins/reorder/web";
import {
  bringWindowToFront,
  restoreWindow,
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
 * slot's reorder layout, hidden apps left out), each with its window count on
 * the active desktop.
 */
export function useLauncherApps(): LauncherApp[] {
  const contributions = Apps.App.useContributions();
  // The contributions carry `_pluginId` + `id`, all the reorder key needs; they
  // lack `_slot`, so widen through `unknown` (as the app launcher popover does).
  const { entries } = useReorderedEntries(
    Apps.App.id,
    contributions as unknown as Contribution[],
  );
  const counts = useWindowsOfApp();
  return useMemo(
    () =>
      entries
        .filter((e) => !isNodeData(e))
        .map((e) => e as unknown as (typeof contributions)[number])
        .filter(isTabApp)
        .map((a) => ({
          id: a.id,
          name: a.app.name,
          icon: a.icon,
          windows: counts.get(a.id)?.length ?? 0,
        })),
    [entries, counts],
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
  const byApp = useWindowsOfApp();
  return {
    activate(appId) {
      const front = byApp.get(appId)?.[0];
      if (!front) {
        openTab(appId);
        return;
      }
      if (front.geo.minimized) restoreWindow(front.id);
      bringWindowToFront(front.id);
      focusTab(front.activeTabId);
    },
    newWindow(appId) {
      openTab(appId);
    },
  };
}
