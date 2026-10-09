import {
  FloatingAction,
  FloatingActionFadeIn,
} from "@plugins/primitives/plugins/overlay/plugins/floating-action/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  type ControlSize,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { SlotItemLayout } from "@plugins/primitives/plugins/slot-render/web";
import { useConfig } from "@plugins/config_v2/web";
import type { ReactNode } from "react";
import { isChromelessDocument } from "@plugins/primitives/plugins/embed/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { HealthReportButton } from "@plugins/shell/plugins/health-report/web";
import { actionBarConfig } from "../../shared/config";
import { useActionBarPinned } from "../internal/use-action-bar-pinned";
import { useFloatingBarSafeArea } from "../internal/use-floating-bar-safe-area";
import { useBarActivities } from "../internal/use-bar-activities";
import type { Activity } from "@plugins/primitives/plugins/css/plugins/activity-ring/web";

/**
 * The density each host draws the bar at. The slots declare `sm` (the docked
 * strip's, inside the 36px tab bar); the floating capsule picks `md` — the
 * chrome's 32px control inside its 40px capsule. Every item of a host shares
 * its one height: the host passes it to each slot's `.Render` and to the
 * health dot, never per item.
 */
const FLOATING_SIZE: ControlSize = "md";
const DOCKED_SIZE: ControlSize = "sm";

/**
 * The bar's resting tone, set once on each host's row: every ghost control in
 * it inherits the muted foreground and brightens to the text colour on hover
 * (ghost's `hover:text-foreground`), so the icons sit quietly until pointed
 * at. The few pieces that read as words — the Improve label, the Build tray's
 * status — set `text-foreground` themselves.
 */
const BAR_TONE = "text-muted-foreground";

/**
 * The floating capsule's scale: the whole capsule (controls, icons, labels,
 * padding, radius) drawn at this fraction of its `md` design, so it shrinks
 * without changing its proportions — the 40px capsule renders 34px tall.
 * One CSS `zoom` rather than a smaller density, which would shrink the
 * controls' boxes but keep their icons and text at full size.
 */
const FLOATING_ZOOM = "[zoom:0.85]";

/**
 * The always-visible leading item: the health report's dot, at its host's
 * density (the one the host gives every other button in the bar).
 */
function HealthItem({
  size,
  activities,
}: {
  size: ControlSize;
  activities?: readonly Activity[];
}) {
  return (
    <ControlSizeProvider size={size}>
      <HealthReportButton activities={activities} />
    </ControlSizeProvider>
  );
}

/**
 * The floating bar's trigger. COLLAPSED, it is the unified mark: everything the
 * bar hides while closed, folded onto the one thing it still shows — background
 * work (`ActionBar.Activity`) rings the health dot and joins its tooltip, things
 * to act on (`ActionBar.Glance`, e.g. Reload) sit beside it. EXPANDED, it is the
 * plain health button again: the open row's items (the Build button, its Reload
 * segment, …) show that information themselves, so nothing shows twice. The
 * docked strip has none of this: its items are always visible.
 *
 * The probes stay mounted either way, so collapsing shows the current answer at
 * once.
 */
function FloatingTrigger({ open }: { open: boolean }) {
  const { probes, activities } = useBarActivities();
  return (
    <Stack direction="row" gap="2xs" align="center">
      {probes}
      <HealthItem
        size={FLOATING_SIZE}
        activities={open ? undefined : activities}
      />
      {open ? null : (
        // Each glance draws its own box (the Reload tray), so the row's flex
        // items are the chips themselves: a glance that has nothing to show
        // (no reload due) generates no box at all and takes no gap — the
        // collapsed capsule stays the 40px circle around the dot.
        <SlotItemLayout orientation="host-owned">
          <ActionBar.Glance.Render controlSize={FLOATING_SIZE} />
        </SlotItemLayout>
      )}
    </Stack>
  );
}

/**
 * The floating bar's band: fixed at the viewport's right edge, publishing the
 * room it occupies as the safe area (see {@link useFloatingBarSafeArea}). Its
 * only in-flow child is the `FloatingAction` hitbox, which is pinned to the
 * COLLAPSED footprint and never follows the open panel — so the band's box is
 * the reservation, whether the bar is open or not. (The trigger is not: the
 * panel grows leftward from the right corner with the trigger at its start, so
 * opening carries the trigger to the expanded row's left end.) Its own
 * component so the reservation exists exactly as long as the band is mounted.
 */
function FloatingBand({ children }: { children: ReactNode }) {
  const ref = useFloatingBarSafeArea();
  return (
    // The band: fixed at the right edge, spanning the header row that
    // reserves the bar's room (CSS anchor positioning, see
    // `floating-bar-band` in app.css), so `my-auto` centres the bar on that
    // header's line at any header height. No header → it hangs at 0.5rem.
    <div
      ref={ref}
      // eslint-disable-next-line layout/no-adhoc-layout -- viewport-edge fixed band anchored to the surface-edge header (outside any transformed ancestor)
      className={`floating-bar-band fixed right-3 z-popover flex flex-col ${BAR_TONE}`}
    >
      {children}
    </div>
  );
}

/**
 * Floating overlay host (mounted at `Core.Root`, outside any transformed
 * ancestor). Renders only when **unpinned** — i.e. in fullscreen (solo) mode: a top-right `z-popover` overlay
 * collapsed to the health dot that hover-expands the action row leftward;
 * clicking the dot opens the health report.
 * Mounting in the root stacking context, one band above the solo placement's
 * `z-overlay` container, keeps it visible in every placement mode, including
 * solo (the headline fix).
 */
export function FloatingActionBarHost() {
  const { enabled } = useConfig(actionBarConfig);
  const pinned = useActionBarPinned();

  // A chromeless embed (`?embed=1`, see `primitives/embed`) has no chrome at
  // all, so the floating overlay stays out too. (The docked host needs no
  // branch: it lives in the tab bar, which a chromeless embed does not
  // render.) An embed that keeps its chrome (`?embed=chrome`) draws it.
  if (!enabled || pinned || isChromelessDocument()) return null;

  return (
    // The bar is chrome wherever it is mounted: floating over the app it still
    // wears the chrome's fixed theme, exactly as the docked strip does inside
    // the tab bar. `none` because the floating panel paints its own card: a
    // glass capsule (pill, `xs` = 4px padding around the 32px `md` controls,
    // so 40px tall, then scaled by FLOATING_ZOOM) that is there collapsed and
    // open alike.
    <Theme name={chromeThemeScope} surface="none">
      <FloatingBand>
        <FloatingAction
          // `relative` so the morphing panel anchors to this hitbox; `shrink-0`
          // so the zero-height fallback band cannot squash it (its only child
          // is absolute, so its min-content height is 0).
          // eslint-disable-next-line layout/no-adhoc-layout -- positioning box of the floating hitbox inside its anchored band (centring + no-squash mechanics, not a layout role)
          className={`relative my-auto shrink-0 ${FLOATING_ZOOM}`}
          anchor="top-right"
          variant="glass"
          shape="pill"
          pad="xs"
          // No gap between the trigger and the reveal strip: the strip is a
          // zero-width flex item while collapsed, and a gap would still widen
          // the capsule by its width. The strip opens its own 2px lead instead.
          gap="none"
          // Every control is the same `md` height, so centring keeps each one on
          // the capsule's centre line — the dot, the glance chips and the row's
          // items alike — as the panel widens.
          align="center"
          trigger={(open) => <FloatingTrigger open={open} />}
        >
          {/* eslint-disable-next-line layout/no-adhoc-layout -- animated max-width hover-reveal strip (clipped while collapsed) */}
          <FloatingActionFadeIn className="flex max-w-0 items-center gap-2xs overflow-hidden group-data-open/fa:pl-2xs whitespace-nowrap transition-[max-width] duration-200 group-data-open/fa:max-w-[80rem]">
            <ActionBar.Item.Render controlSize={FLOATING_SIZE} />
          </FloatingActionFadeIn>
        </FloatingAction>
      </FloatingBand>
    </Theme>
  );
}

/**
 * Docked strip host (mounted at `Apps.TabBarActions`, the tab bar's trailing
 * zone). Renders only when **pinned** — i.e. in desktop and tab modes: a
 * right-aligned, non-compressing strip the tab strip scrolls under.
 */
export function DockedActionBarHost() {
  const { enabled } = useConfig(actionBarConfig);
  const pinned = useActionBarPinned();

  if (!enabled || !pinned) return null;

  return (
    <Stack
      direction="row"
      gap="2xs"
      align="center"
      // eslint-disable-next-line layout/no-adhoc-layout -- rigid leaf of the tab bar's flex (must not compress as tabs scroll under it)
      className={`shrink-0 pl-sm ${BAR_TONE}`}
    >
      <HealthItem size={DOCKED_SIZE} />
      <ActionBar.Item.Render controlSize={DOCKED_SIZE} />
    </Stack>
  );
}
