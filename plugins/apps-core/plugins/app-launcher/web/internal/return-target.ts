import {
  Apps,
  routePrefixForMode,
  type ActiveApp,
} from "@plugins/apps-core/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";

/**
 * Where the user came from, when that is an app made for opening others — the
 * app the launcher offers to go back to ("Back to Desktop", "Back to Isle"):
 *
 * - the surface-mode app the surface just LEFT (the desktop, after a window
 *   went full screen): its windows are still there, and picking it brings
 *   them back. Not while the surface is in a surface-mode app itself.
 * - else the launcher app the focused tab was opened from (`Tab.openedFrom`,
 *   an app declared `defineApp({ launcher: true })` — Isle).
 *
 * Read from the tab set, so it answers for the set the launcher is drawn in.
 */
export function useReturnTarget(): ActiveApp | undefined {
  const { mode, previousMode, tabs, focusedTabId } = useTabs();
  const apps = Apps.App.useContributions();
  if (routePrefixForMode(mode, apps) !== undefined) return undefined;
  if (previousMode !== mode) {
    const surfaceApp = apps.find((a) => a.surfaceMode === previousMode);
    if (surfaceApp) return surfaceApp;
  }
  const openedFrom = tabs.find((t) => t.tabId === focusedTabId)?.openedFrom;
  if (openedFrom === undefined) return undefined;
  return apps.find((a) => a.id === openedFrom);
}
