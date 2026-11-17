import {
  Apps,
  routePrefixForMode,
  type ActiveApp,
} from "@plugins/apps-core/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";

/**
 * Where the user came from, when that is an app made for opening others — the
 * app the launcher offers to go back to ("Back to Isle", "Back to Desktop").
 * The way back is a stack, the most recent step first:
 *
 * - the top of the focused tab's own way back (`Tab.openedFrom`: the launcher
 *   apps — `defineApp({ launcher: true })`, Isle — it was opened from);
 * - under it, the surface-mode app the surface LEFT (the desktop, after a
 *   window went full screen): its windows are still there, and picking it
 *   brings them back. Not while the surface is in a surface-mode app itself.
 *
 * Desktop → Isle full screen → an app: "Back to Isle", then from Isle "Back
 * to Desktop".
 *
 * Read from the tab set, so it answers for the set the launcher is drawn in.
 */
export function useReturnTarget(): ActiveApp | undefined {
  const { mode, previousMode, tabs, focusedTabId } = useTabs();
  const apps = Apps.App.useContributions();
  if (routePrefixForMode(mode, apps) !== undefined) return undefined;
  const openedFrom = tabs.find((t) => t.tabId === focusedTabId)?.openedFrom;
  const top = openedFrom?.at(-1);
  if (top !== undefined) {
    const launcherApp = apps.find((a) => a.id === top);
    if (launcherApp) return launcherApp;
  }
  if (previousMode === mode) return undefined;
  return apps.find((a) => a.surfaceMode === previousMode);
}
