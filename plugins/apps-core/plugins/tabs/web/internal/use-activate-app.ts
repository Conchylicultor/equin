import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { useAppNavBoundary } from "@plugins/primitives/plugins/pane/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { useHomeApp, type ActiveApp } from "@plugins/apps-core/web";
import { useTabs } from "./use-tabs";

/**
 * Switch to an installed app, exactly as every app switcher does: a
 * surface-mode app (the desktop) switches the surface to its mode; any other
 * app swaps in place in the tab
 * the switcher is drawn in — its own surface tab (a Home window, an app's
 * header), or the focused tab for chrome outside any surface (the app rail).
 *
 * The one statement of "activate an app entry", shared by the rail, the
 * launcher popover and the Home gallery so they cannot disagree about which
 * tab a pick lands in.
 *
 * Returns an {@link Activation}: a tab app is a LINK
 * to its base path, so a middle- / ⌘-click on it opens the app in a new
 * browser tab. Spread it with `activationProps`, or hand it to a DataView's
 * `rowActivation`. A surface-mode app switches the mode of the tab set the
 * switcher is drawn in (`useTabs()` — inside an `AppEmbed`, the embed's own);
 * inside an `AppNavBoundary` (an in-process app embed) a tab app's switch is
 * the boundary's, so a switcher drawn in an embed never swaps the host's tab.
 */
export function useActivateApp(): (
  entry: Pick<ActiveApp, "id" | "surfaceMode" | "app">,
) => Activation {
  const { tabs, focusedTabId, replaceTabApp, openTab, closeTab, setMode } =
    useTabs();
  const ownTabId = useSurfaceTabId();
  const boundary = useAppNavBoundary();
  const home = useHomeApp();
  return (entry) => {
    const tabId = ownTabId ?? focusedTabId;
    // A surface-mode app switches this page's surface to its mode; its URL is
    // its base path as a route prefix (bare `/desktop`: that mode, nothing
    // open), so ⌘/middle-click opens it fresh in a new browser tab. Picked from
    // the home app (the gallery), it is also what the gallery tab was open
    // for — the tab is consumed, as a tab app's pick swaps it in place — so the
    // desktop opens clear rather than holding a Home window.
    const mode = entry.surfaceMode;
    if (mode !== undefined)
      return {
        open: () => {
          setMode(mode);
          const launchedFrom = tabs.find((t) => t.tabId === tabId);
          if (
            launchedFrom !== undefined &&
            home.kind === "app" &&
            launchedFrom.appId === home.app.id
          ) {
            closeTab(launchedFrom.tabId);
          }
        },
        href: () => entry.app.basePath,
      };
    // Inside an embed a tab app's pick is the boundary's: checked before
    // anything that would drive the host's tabs.
    if (boundary !== null)
      return {
        open: () => boundary(entry.app.basePath),
        href: () => entry.app.basePath,
      };
    return {
      open: () =>
        tabId === undefined
          ? // An empty surface (the desktop, every window closed) has no tab
            // to swap: the pick opens one.
            openTab(entry.id)
          : replaceTabApp(tabId, entry.id),
      href: () => entry.app.basePath,
    };
  };
}
