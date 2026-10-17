import { useMemo } from "react";
import { Apps } from "@plugins/apps-core/web";
import { useTabs, type Tab } from "@plugins/apps-core/plugins/tabs/web";
import { TabIcon } from "@plugins/ui/plugins/tab-bar/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { selfClass } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  bringWindowToFront,
  restoreWindow,
  useDesktops,
  useFloatingWindows,
  windowForTab,
  type FloatingWindow,
} from "../hooks/use-floating-windows";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { WorkspacePager } from "./workspace-pager";

/**
 * The desktop dock (taskbar) for floating windows — the floating placement's
 * {@link PlacementDef.Foreground}, rendered once above all windows whenever the
 * floating Foreground is mounted. A macOS-style centered, translucent bar: one
 * chip per **window on the active virtual desktop** (active member's app icon +
 * title, suffixed ` (N)` when the window groups several tabs). The focused (and
 * visible) window reads as active; minimized windows dim, since they have fully
 * left the desktop. It is the restore target once a window is minimized.
 *
 * Its LEFT segment hosts the {@link WorkspacePager} — the per-desktop pager,
 * whose pills are miniature desktops (each window drawn at its real position) —
 * separated from the window chips by a thin divider, so the whole thing reads as
 * one cohesive bottom shelf (KDE / ChromeOS pattern) rather than two competing
 * centered bars. The pager organizes windows; like the dock it is still
 * windows/organization-only, never an app launcher (see this plugin's CLAUDE.md
 * passive-backdrop invariant). The bar therefore always renders while the
 * Foreground is mounted — even when the active desktop has zero windows, the user
 * must still see and switch desktops.
 *
 * The pager's mini-desktops need the desktop's pixel size to place a free window
 * (a snapped window resolves resolution-independently). We measure the dock
 * anchor's `offsetParent` — the desktop backdrop, a `position: relative` box —
 * via {@link useElementSize}'s `ResizeObserver` and hand it to the pager.
 *
 * Click follows the taskbar convention: the already-focused, non-minimized
 * window minimizes (toggles back to the dock); any other (or a minimized) window
 * un-minimizes, raises to front, and focuses its active member. Each chip is a
 * {@link ToggleChip} (the canonical stateful pill — icon + truncating label +
 * active state) so the dock writes no raw layout mechanics; the chips wrap via
 * {@link Cluster}.
 */
export function WindowDock({ tabIds }: { tabIds: string[] }) {
  const { tabs, titles, focusedTabId, focusTab } = useTabs();
  const map = useFloatingWindows();
  const { activeDesktopId } = useDesktops();
  const apps = Apps.App.useContributions();

  // Measure the desktop backdrop (the anchor's offsetParent) so the pager's
  // mini-desktops can scale each free window's pixel box into a desktop fraction.
  const [anchorRef, { width: desktopW, height: desktopH }] =
    useElementSize<HTMLDivElement>((el) => el.offsetParent);

  // tabId → Tab, so each chip can resolve its app (icon / name) from appId.
  const byTabId = useMemo(() => {
    const m = new Map<string, Tab>();
    for (const t of tabs) m.set(t.tabId, t);
    return m;
  }, [tabs]);

  // Windows in the open-tab order: walk the open floating tabIds, mapping each to
  // its window and deduping (so a grouped window appears once, at its first
  // member's position). Filtered to the ACTIVE desktop — off-desktop windows are
  // hidden (display:none) and must not appear as taskbar chips. Keeps the dock
  // ordering stable and aligned with the apps tab order, exactly like cycle order.
  const windows = useMemo(() => {
    const seen = new Set<string>();
    const out: FloatingWindow[] = [];
    for (const tabId of tabIds) {
      const wid = windowForTab(tabId);
      if (!wid || seen.has(wid)) continue;
      const win = map.get(wid);
      if (!win || win.desktopId !== activeDesktopId) continue;
      seen.add(wid);
      out.push(win);
    }
    return out;
  }, [tabIds, map, activeDesktopId]);

  return (
    // The bottom-centered floating dock anchor over the desktop. This is the one
    // genuinely-positioned element — no layout primitive models a within-surface
    // (non-portaled) floating bar (viewport-overlay portals to <body>, escaping
    // the surface bounds), so the absolute anchor escapes the layout gate here.
    <div
      ref={anchorRef}
      // eslint-disable-next-line layout/no-adhoc-layout -- genuine one-off: bottom-center desktop dock anchor; no positioning primitive models a within-surface floating bar
      className="pointer-events-none absolute bottom-3 left-1/2 z-overlay -translate-x-1/2"
    >
      <Cluster
        gap="xs"
        className="pointer-events-auto rounded-lg border bg-muted/70 px-sm py-xs shadow-lg backdrop-blur"
      >
        {/* Per-desktop workspace pager on the LEFT, then a thin divider, then the
            active desktop's window chips — one cohesive bottom shelf. The divider
            is dropped when there are no chips (empty active desktop = pager only). */}
        <WorkspacePager desktopW={desktopW} desktopH={desktopH} />
        {windows.length > 0 && (
          // A 1px hairline separating the pager from the chips. No layout
          // primitive models an in-row divider; the smallest acceptable construct.
          // (`w-px`/`bg-border` are sizing and color — neither is banned.)
          <div
            aria-hidden
            className={cn("w-px", selfClass("stretch"), "bg-border")}
          />
        )}
        {windows.map((win) => {
          const tab = byTabId.get(win.activeTabId);
          const entry = apps.find((a) => a.id === tab?.appId);
          const base = titles[win.activeTabId] ?? entry?.app.name ?? "Window";
          const label =
            win.members.length > 1 ? `${base} (${win.members.length})` : base;
          const minimized = win.geo.minimized;
          const active = focusedTabId === win.activeTabId && !minimized;

          const onClick = () => {
            if (focusedTabId === win.activeTabId && !minimized) {
              restoreWindow(win.id, /* minimize */ true);
            } else {
              restoreWindow(win.id); // un-minimize if it was
              bringWindowToFront(win.id);
              focusTab(win.activeTabId);
            }
          };

          return (
            <ToggleChip
              key={win.id}
              active={active}
              variant="ghost"
              // Reuse the tab's icon+badge composition so the dock chip's
              // per-app attention dot (e.g. the active member's Mail
              // sync-error) is pixel-identical to the tab-strip / docked bar.
              icon={
                entry?.icon ? (
                  <TabIcon icon={entry.icon.symbol} badge={entry.badge} />
                ) : undefined
              }
              onClick={onClick}
              tooltip={label}
              className={cn("max-w-40", minimized && "opacity-60")}
            >
              {label}
            </ToggleChip>
          );
        })}
      </Cluster>
    </div>
  );
}
