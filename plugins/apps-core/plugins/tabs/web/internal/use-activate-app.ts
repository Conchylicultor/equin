import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { useAppNavBoundary } from "@plugins/primitives/plugins/pane/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import type { ActiveApp } from "@plugins/apps-core/web";
import { useTabs } from "./use-tabs";

/**
 * Switch to an installed app, exactly as every app switcher does: the entry's
 * own `onClick` when it declares one, else swap the app in place in the tab
 * the switcher is drawn in — its own surface tab (a Home window, an app's
 * header), or the focused tab for chrome outside any surface (the app rail).
 *
 * The one statement of "activate an app entry", shared by the rail, the
 * launcher popover and the Home gallery so they cannot disagree about which
 * tab a pick lands in.
 *
 * Returns an {@link Activation}: an app with no `onClick` of its own is a LINK
 * to its base path, so a middle- / ⌘-click on it opens the app in a new
 * browser tab. Spread it with `activationProps`, or hand it to a DataView's
 * `rowActivation`. Inside an `AppNavBoundary` (an in-process app embed) the
 * switch is the boundary's: its navigator is handed the app's base path, so a
 * switcher drawn in an embed never swaps the host's tab.
 */
export function useActivateApp(): (
  entry: Pick<ActiveApp, "id" | "onClick" | "app">,
) => Activation {
  const { focusedTabId, replaceTabApp } = useTabs();
  const ownTabId = useSurfaceTabId();
  const boundary = useAppNavBoundary();
  return (entry) => {
    // An entry's own `onClick` is an action, not a destination.
    if (entry.onClick) return entry.onClick;
    return {
      open: () =>
        boundary !== null
          ? boundary(entry.app.basePath)
          : replaceTabApp(ownTabId ?? focusedTabId, entry.id),
      href: () => entry.app.basePath,
    };
  };
}
