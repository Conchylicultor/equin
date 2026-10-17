import { type ComponentType } from "react";
import { useRevealOnActive } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  cn,
  ControlSizeProvider,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { AdaptiveBar } from "@plugins/primitives/plugins/adaptive-bar/web";
import { GrowRelay } from "@plugins/primitives/plugins/css/plugins/grow-relay/web";
import { useActionForm } from "@plugins/primitives/plugins/action-presentation/web";
import {
  SortableList,
  SortableItem,
} from "@plugins/primitives/plugins/sortable-list/web";
import { Tab, useActiveTabVariant } from "@plugins/ui/plugins/tab-bar/web";
import { Apps } from "@plugins/apps-core/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import {
  useTabs,
  placementIsNewTabFollows,
  usePlacementCapabilities,
} from "@plugins/apps-core/plugins/tabs/web";
import { ChromeMark } from "./chrome-mark";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

const addIcon = symbol("add");

/** Bar-item id of the trailing `+`; tab ids are uuids, so it can't collide. */
const NEW_TAB_ITEM_ID = "new-tab";

/**
 * Horizontal tab bar above the app content (parallel to {@link AppRail}). One
 * tab per open tab — app icon + a label derived from the tab's active
 * pane/route (falling back to the app name) — with an active highlight on the
 * focused tab; clicking focuses it. Hovering a tab reveals a trailing `×`. The
 * tab itself is the themable {@link Tab} primitive, which renders the active
 * variant (chip / underline / connected); this bar no longer owns any chip
 * markup — it only arranges and wires behavior.
 *
 * Overflow: tabs collapse to icon-only one at a time, only as the strip runs
 * out of space, and the focused tab is the last one to give up its label. None
 * of that is decided here — the strip is an {@link AdaptiveBar}, and each tab
 * declares its own ladder (see {@link TabChip}), so this bar names no
 * privileged child. `overflow="scroll"` because every tab must stay reachable:
 * a tab may shrink but may never leave the row, so once even icon-only tabs
 * don't fit, the row scrolls.
 *
 * The `+` is an occupant of the bar too, which is what keeps it beside the last
 * tab AND has its width reserved by the fit — the old hand-rolled measurement
 * ignored it entirely.
 */
export function AppTabBar() {
  const {
    tabs,
    focusedTabId,
    focusTab,
    closeTab,
    openTab,
    moveTab,
    mode,
    titles,
  } = useTabs();
  const apps = Apps.App.useContributions();

  // The active variant decides the strip's vertical geometry (see the variant's
  // `strip`): `padded` centres compact tabs above a bottom border; `flush` and
  // `folder` stretch every tab to the strip's full height — `flush` keeping the
  // border so an underline lands on it, `folder` dropping it so the active tab's
  // bottom edge is the content seam.
  const strip = useActiveTabVariant()?.strip ?? "padded";
  const fillHeight = strip !== "padded";

  // The surface mode determines how `+` reads: in windows mode it opens a "new
  // window", otherwise a "new tab". Either way `openTab` adds a tab under the
  // current mode — the surface owns the mode, not the tab. (The tab bar is
  // covered while the surface is solo, so `+` is unreachable in that state.)
  //
  // Subscribed: the placement registry is filled by the surface body's effect,
  // in a different subtree, so this bar renders before it exists. Reading it
  // through the hook is what re-renders the `+` when it lands — asking the
  // registry directly here left the button stuck on "new tab" from boot.
  const placements = usePlacementCapabilities();
  const newTabIsWindow = placementIsNewTabFollows(placements, mode);

  const resolved = tabs.flatMap((tab) => {
    const entry = apps.find((a) => a.id === tab.appId);
    if (!entry) return [];
    // The tab's selected content (page / conversation / song …); the app name is
    // the fallback when the tab is at its index or its pane has no title.
    const label = titles[tab.tabId] ?? entry.app.name;
    return [{ tab, entry, label }];
  });

  return (
    // `GrowRelay.Stop`: this Stack IS the strip, so the bar's grow ask has
    // arrived. It is not a <Line> (the bar inside owns the single-line
    // contract), so it says so itself rather than inheriting it.
    <GrowRelay.Stop>
      <Theme
        as={Stack}
        direction="row"
        align="center"
        gap="none"
        // One element is now the whole boundary — the scope tag, the portal
        // forward that used to be a separate wrapper outside `GrowRelay.Stop`,
        // and the paint. (Context crosses the DOM freely, so collapsing the
        // wrapper onto the strip itself changes nothing about what portaled
        // popovers read.) It wears the chrome's fixed theme, the same whichever
        // app is focused, and so does everything opened from it.
        name={chromeThemeScope}
        // The tab strip is chrome frame (like the sidebar/rail), so it wears the
        // recessed `--sidebar` surface — distinct from `--background`. That
        // figure/ground gap is what lets the active "connected" tab (which is
        // `bg-background`, matching the content surface directly below it) read as
        // raised out of the strip and fused with the content. A same-as-content
        // strip (e.g. `surface="canvas"`) would erase the contrast; a `sunken`
        // one is unsafe because some presets make `--muted` lighter than
        // `--background`. `chrome` is the role that says exactly this, and it
        // brings the two helper vars `--sidebar` implies (a ghost control in the
        // trailing action zone hovers to `--sidebar-accent`, not to the page
        // canvas's `--muted`, which would read as no hover at all).
        surface="chrome"
        // One chrome-bar height whatever the variant. A `folder` strip drops
        // its border-b so the full-height active tab's bottom edge IS the
        // content seam (no line) — the colour step alone separates strip from
        // content. Idle controls in the strip (the `+`, the action bar's icons)
        // read the muted text colour and step up to full on hover.
        // eslint-disable-next-line layout/no-adhoc-layout -- shrink-0 keeps the rigid tab bar's chrome height above the flexible tab body
        className={cn(
          "h-chrome-bar shrink-0 pr-sm text-muted-foreground",
          strip === "padded" && "border-b py-2xs",
          strip === "flush" && "border-b",
          strip === "folder" && "pt-2xs",
        )}
      >
        <ChromeMark />
        {/* The bar IS the strip's grow cell (`min-w-0 flex-1`), which is why the
        old `flex-1` spacer below the `+` is gone: a second claimant on the
        same slack would leave the bar reading half the width it actually has,
        and it would compact tabs while the row still had room. It absorbing
        the slack is also what pins the trailing actions to the right edge.
        self-stretch/items-stretch (fillHeight only): the strip's full height
        reaches each tab so a folder tab's bottom edge lands on the content
        seam; the trailing actions stay centered (the strip is items-center). */}
        <AdaptiveBar
          overflow="scroll"
          gap="2xs"
          // eslint-disable-next-line layout/no-adhoc-layout -- the folder variant's full-height pass-through, waiting on a cross-axis alignment prop on AdaptiveBar. `self-stretch` alone IS now expressible (spacing's selfClass("stretch")), but `items-stretch` is AdaptiveBar's OWN cross-axis alignment of its occupants — its `align` prop is main-axis (where they sit in the slack) and does not cover it. Draining half of this with selfClass would leave the other half here and foreclose the right fix, so both halves stay until AdaptiveBar grows the prop.
          className={fillHeight ? "items-stretch self-stretch" : undefined}
        >
          <SortableList
            items={resolved.map(({ tab }) => tab.tabId)}
            onMove={(activeId, overId) => moveTab(activeId, overId)}
            orientation="horizontal"
            disabled={tabs.length < 2}
          >
            {resolved.map(({ tab, entry, label }) => (
              // The item wraps the SortableItem, never the other way round: the
              // bar docks each container immediately before its own anchor, so
              // the anchor has to be the bar's own child — and dnd-kit's node (and
              // its transform) has to travel INSIDE the container it moves.
              <AdaptiveBar.Item key={tab.tabId} id={tab.tabId}>
                {/* Whole-chip drag: the sortable-list PointerSensor's 4px activation
                distance lets a click still activate / close the tab. */}
                {/* No `min-w-0` any more, and its absence is the point: this div
                used to be a flex item of the strip, where min-width:auto would
                have stopped a long label shrinking. Inside a bar it is a plain
                block child of the item's own container, so min-width never
                applied — and the shrinking is the bar's job now anyway (full →
                icon-only), with the chip's own `max-w-40` + truncating `Text`
                leaf handling what is left. `h-full` carries the strip's
                stretched height down to the folder tab. */}
                <SortableItem
                  id={tab.tabId}
                  className={(s) =>
                    cn(fillHeight && "h-full", s.isDragging && "opacity-50")
                  }
                >
                  {() => (
                    <TabChip
                      appId={tab.appId}
                      icon={entry.icon.symbol}
                      // Ambient per-app attention indicator (e.g. Mail sync-error,
                      // Settings config-conflict) — the same badge the app-rail
                      // icon paints, now on the more-proximate tab chip. Rides the
                      // icon so it survives collapsed/icon-only mode.
                      badge={entry.badge}
                      label={label}
                      active={tab.tabId === focusedTabId}
                      fillHeight={fillHeight}
                      onActivate={() => focusTab(tab.tabId)}
                      onClose={() => closeTab(tab.tabId)}
                    />
                  )}
                </SortableItem>
              </AdaptiveBar.Item>
            ))}
          </SortableList>
          <AdaptiveBar.Item id={NEW_TAB_ITEM_ID}>
            {/* Same full-height box the tab chips sit in, so `+` stays vertically
            centered when the strip stretches for the folder variant. */}
            <Line as="div" className={fillHeight ? "h-full" : undefined}>
              <ControlSizeProvider size="sm">
                <IconButton
                  icon={addIcon}
                  label={newTabIsWindow ? "New window" : "New tab"}
                  onClick={() => openTab("home")}
                />
              </ControlSizeProvider>
            </Line>
          </AdaptiveBar.Item>
        </AdaptiveBar>
        {/* Trailing action zone — the `surface` plugin drops its placement control
        here and the global action bar pins itself to the right edge. */}
        <Apps.TabBarActions.Render />
      </Theme>
    </GrowRelay.Stop>
  );
}

interface TabChipProps {
  appId: string;
  icon: IconRef;
  /** Optional per-app attention overlay, pinned to the tab icon (see TabIcon). */
  badge?: ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  /** Full-height strip (flush / folder variants) — the wrapper fills the row so the
   *  variant's own `h-full` can reach the bottom seam. */
  fillHeight?: boolean;
  onActivate?: () => void;
  onClose?: () => void;
}

/**
 * One interactive tab; the focused tab scrolls itself into view. The themable
 * {@link Tab} primitive can't forward a root ref (it dispatches to a sealed
 * variant), so this wraps it in a tight {@link Line} box that owns the DOM
 * handle: `WithTooltip`'s trigger anchors to that box and `scrollIntoView`
 * targets it. The active/icon/label/onActivate/onClose props pass straight
 * through to the variant.
 *
 * The tab declares its OWN shrink policy: it can render icon-only, and the
 * focused one yields last. That is the whole point of the seam — every tab is
 * the same component, and only the focused instance says `"never"`, so a bar
 * could not have expressed this without naming its privileged child.
 * `"never"` is a rank, not a pin: a strip too narrow for even one label
 * collapses the focused tab too rather than breaking the row.
 */
function TabChip({ appId, fillHeight, ...props }: TabChipProps) {
  const { active } = props;
  const form = useActionForm({
    shrinksTo: ["compact"],
    yields: active ? "never" : "normal",
  });
  // A newly focused tab reveals itself in the strip — on mount (a tab spawned
  // already-active) and on the false→true focus transition. Base UI's tooltip
  // trigger composes its own ref into `Line` via `render`, so this callback ref
  // is the DOM handle scrollIntoView needs.
  const revealRef = useRevealOnActive(active, {
    revealOnMount: true,
    inline: "nearest",
    block: "nearest",
  });
  return (
    <WithTooltip content={props.label}>
      {/* h-full lets the inner variant fill the full-height strip down to the
          content seam; fillHeight is a strip-geometry concern, so it stays here
          and is never forwarded onto the variant (would leak to the DOM). */}
      <Line
        as="div"
        ref={revealRef}
        data-app-tab={appId}
        className={fillHeight ? "h-full" : undefined}
      >
        <Tab {...props} collapsed={form === "compact"} />
      </Line>
    </WithTooltip>
  );
}
