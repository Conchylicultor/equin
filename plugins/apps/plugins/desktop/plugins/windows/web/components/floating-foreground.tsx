import { Fragment, useEffect } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { desktopThemeScope } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import { Desktop } from "../slots";
import { SnapPreviewOverlay } from "./snap-preview-overlay";
import { TabDragOverlay } from "./tab-drag-overlay";
import { FloatingTabsBridge } from "./floating-tabs-bridge";
import { OverviewLayer } from "./overview-layer";
import { DeskFrame } from "./desk-frame";
import { pruneWindows } from "../hooks/use-floating-windows";

/**
 * The floating placement's `Foreground`: the always-on overlay layer above every
 * window container. Composes the desktop's own window cues — the snap ghost, the
 * tab-drag ghost / tear-off preview, the overview's labels and click targets —
 * inside the desktop's theme, every `Desktop.Overlay` contribution (shelf,
 * launcher, switcher), and two headless publishers: the tabs bridge (which feeds
 * the keyboard window-management shortcuts) and the desk frame (the desktop's
 * size, for the commands that lay windows out).
 *
 * Receives two id sets from the surface host's exit-presence layer: `tabIds`
 * (LIVE floating tabs) and `retainedTabIds` (live + those still animating out).
 * Only the LIVE ids reach the overlays + tabs-bridge — a closing window leaves
 * the shelf immediately and can't be switched to while it animates. The
 * store reconcile (`pruneWindows`) lives here (not in a per-window chrome) and
 * keys on BOTH sets, so a window mid-exit-tween is retained until its retention
 * ends rather than pruned out from under its chrome.
 *
 * The reconcile is a single keyed effect that runs WHILE MOUNTED — on mount and
 * whenever the retained set changes — never on unmount. This Foreground unmounts
 * on every surface-mode switch (it renders only in `floating` mode), which is NOT
 * the same as "no floating windows exist", so no teardown may touch the geometry
 * store; a mode round-trip must leave every window's box intact to be restored on
 * re-entry. The while-mounted reconcile still covers both prune cases: a genuine
 * last-tab-close empties `retainedTabIds` (→ the now-empty window is pruned), and
 * stale entries left by tabs closed while away from `floating` mode are pruned on
 * re-entry when the effect re-runs against the current live set.
 */
export function FloatingForeground({
  tabIds,
  retainedTabIds,
}: {
  tabIds: string[];
  retainedTabIds: string[];
}) {
  // Reconcile windows against the live + retained sets. Keyed on a stable join of
  // the RETAINED ids (a superset of live), so it re-runs both when a tab starts
  // exiting (live shrinks, prune reveals a sibling / keeps the window) and when
  // its retention ends (retained shrinks, prune deletes the empty window).
  const retainedKey = retainedTabIds.join(",");
  useEffect(() => {
    pruneWindows(new Set(tabIds), new Set(retainedTabIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id set, not the array identity (mirrors the tabs-bridge effect)
  }, [retainedKey]);

  return (
    <>
      <FloatingTabsBridge tabIds={tabIds} />
      <DeskFrame />
      <Theme name={desktopThemeScope} surface="none">
        <SnapPreviewOverlay />
        <OverviewLayer />
        <TabDragOverlay />
      </Theme>
      <DesktopOverlays tabIds={tabIds} />
    </>
  );
}

/**
 * Every `Desktop.Overlay` contribution (shelf, launcher, switcher),
 * each isolated in its own boundary, all inside the desktop's own theme — so
 * the desktop's chrome wears `app:desktop` whatever the windows' apps wear.
 * `surface="none"`: the boundary scopes tokens and paints nothing (every layer
 * paints its own panels over the windows).
 */
function DesktopOverlays({ tabIds }: { tabIds: string[] }) {
  const overlays = Desktop.Overlay.useContributions();
  return (
    <Theme name={desktopThemeScope} surface="none">
      {overlays.map((overlay) => (
        <Fragment key={overlay.id}>
          {renderIsolated(Desktop.Overlay, overlay as unknown as Contribution, {
            tabIds,
          })}
        </Fragment>
      ))}
    </Theme>
  );
}
