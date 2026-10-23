import { useEffect, useRef } from "react";
import { useFocusedAppId } from "@plugins/apps-core/web";
import { peekRoute, usePathname } from "@plugins/primitives/plugins/pane/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import type { StallTab } from "../../core";
import { installStallWatch, type StallWatch } from "../internal/tab-watch";

/**
 * The route as a pattern: the focused tab's pane ids, never their params, so
 * the same screen is the same fingerprint whatever record it shows.
 */
function routePattern(): string {
  const panes = peekRoute().map((s) => s.paneId);
  return panes.length > 0 ? panes.join("/") : "(root)";
}

/**
 * Invisible global controller (Core.Root): installs the tab half of the
 * main-thread stall detector once, and re-tells the watchdog where this tab
 * is whenever the focused app or the route changes — a frozen tab cannot say
 * it later, so its last word must already be current.
 */
export function MainThreadStallController(): null {
  const app = useFocusedAppId() ?? null;
  const pathname = usePathname();
  const appRef = useLatestRef(app);
  const watch = useRef<StallWatch | null>(null);

  useEffect(() => {
    const readTab = (): StallTab => ({
      tabId: getTabId(),
      app: appRef.current,
      routePattern: routePattern(),
      url: window.location.href,
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
    });
    const w = installStallWatch(readTab);
    watch.current = w;
    return () => {
      watch.current = null;
      w.dispose();
    };
  }, [appRef]);

  useEffect(() => {
    watch.current?.refresh();
  }, [app, pathname]);

  return null;
}
