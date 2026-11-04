import { useEffect, useMemo } from "react";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import { useDesktop } from "../internal/desktop-runtime";

/**
 * Headless publisher: mirrors the live floating tab order + focus/close/open
 * callbacks into the {@link the desktop's tabs bridge (`desk.installTabs`)} install sink so the
 * statically-registered window-management shortcuts (close, new window, the
 * overview's pick) can act on windows without the load-bearing `apps` plugin
 * exposing imperative tab handles. Mounted inside the floating Foreground, so
 * it exists exactly while the desktop is shown (and the shortcuts' `when`
 * guard can pass).
 *
 * The effect returns `install`'s own disposer, which restores the PREVIOUS
 * occupant rather than blindly emptying the slot — so a StrictMode double-mount
 * or a re-install on a tab-set change cannot leave the shortcuts with no bridge.
 */
export function FloatingTabsBridge({ tabIds }: { tabIds: string[] }) {
  const { tabs, focusTab, closeTab, openTab } = useTabs();
  const appOf = useMemo(
    () => new Map(tabs.map((t) => [t.tabId, t.appId])),
    [tabs],
  );
  const tabKey = tabIds.join(",");
  const desk = useDesktop();
  useEffect(
    () =>
      desk.installTabs({
        tabIds,
        focusTab,
        closeTab,
        openTab,
        appIdOf: (tabId) => appOf.get(tabId),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id set, not the array identity (mirrors FloatingChrome's prune effect)
    [tabKey, focusTab, closeTab, openTab, appOf, desk],
  );
  return null;
}
