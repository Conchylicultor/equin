import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { useAppNavBoundary } from "@plugins/primitives/plugins/pane/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { useHomeApp, type ActiveApp } from "@plugins/apps-core/web";
import { setSurfaceMode, useTabs } from "./use-tabs";

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
 * `rowActivation`. Inside an `AppNavBoundary` (an in-process app embed) the
 * switch is the boundary's — for a surface-mode app too: its navigator is
 * handed the app's base path, so a switcher drawn in an embed never swaps the
 * host's tab nor switches the host's surface mode.
 */
export function useActivateApp(): (
  entry: Pick<ActiveApp, "id" | "surfaceMode" | "app">,
) => Activation {
  const { tabs, focusedTabId, replaceTabApp, openTab, closeTab } = useTabs();
  const ownTabId = useSurfaceTabId();
  const boundary = useAppNavBoundary();
  const home = useHomeApp();
  return (entry) => {
    // Inside an embed every pick is the boundary's — a surface-mode app too:
    // checked before anything that would drive the host's tabs or surface. The
    // boundary decides (a surface-mode app owns no URL it can hold, so an embed
    // hands it to its `onLeave`).
    if (boundary !== null)
      return {
        open: () => boundary(entry.app.basePath),
        href: () => entry.app.basePath,
      };
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
          setSurfaceMode(mode);
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
