import {
  FloatingAction,
  FloatingActionFadeIn,
} from "@plugins/primitives/plugins/overlay/plugins/floating-action/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  type ControlSize,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { SlotItemLayout } from "@plugins/primitives/plugins/slot-render/web";
import { useConfig } from "@plugins/config_v2/web";
import { useRef, useState, type ReactNode } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useDragGesture } from "@plugins/primitives/plugins/dom/plugins/movable/web";
import { isChromelessDocument } from "@plugins/primitives/plugins/embed/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { HealthReportButton } from "@plugins/shell/plugins/health-report/web";
import { actionBarConfig } from "../../shared/config";
import { useActionBarPinned } from "../internal/use-action-bar-pinned";
import { useFloatingBarSafeArea } from "../internal/use-floating-bar-safe-area";
import { useBarPlace, useViewportSize } from "../internal/use-bar-place";
import { useBarActivities } from "../internal/use-bar-activities";
import type { Activity } from "@plugins/primitives/plugins/css/plugins/activity-ring/web";

/**
 * The density each host draws the bar at. The slots declare `sm` (the docked
 * strip's, inside the 36px tab bar); the floating capsule picks `md` — 32px
 * controls in a 36px capsule (2px padding), so each hover circle keeps 8px
 * around its 16px icon. Every item of a host shares its one height: the host
 * passes it to each slot's `.Render` and to the health dot, never per item.
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
        // collapsed capsule stays the 36px circle around the dot.
        <SlotItemLayout orientation="host-owned">
          <ActionBar.Glance.Render controlSize={FLOATING_SIZE} />
        </SlotItemLayout>
      )}
    </Stack>
  );
}

/** The gap kept between the dragged bar and the viewport's edges. */
const EDGE_GAP_PX = 8;
/**
 * How close (px) the dragged bar's centre must come to its home slot's centre
 * to snap back into it on drop.
 */
const SNAP_RADIUS_PX = 72;

interface Point {
  x: number;
  y: number;
}

interface Drag {
  /** The collapsed bar's centre, in viewport px. */
  cx: number;
  cy: number;
  /** Over the home slot: dropping here snaps the bar back into it. */
  overHome: boolean;
}

/** Which edge of the screen the open row grows away from. */
type GrowFrom = "left" | "right";

const centreOf = (b: DOMRect): Point => ({
  x: b.left + b.width / 2,
  y: b.top + b.height / 2,
});
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(Math.max(lo, hi), v));

/**
 * The floating bar, where the user put it. At HOME (the default) it sits in
 * its slot at the surface's top-right corner, centred on the top header's line
 * (`floating-bar-band`), and that header reserves its room (the safe area, see
 * {@link useFloatingBarSafeArea}). Dragged anywhere else, it floats there over
 * the app and the reservation is withdrawn: the header's actions glide into the
 * room it leaves. Dragged back near its slot, the slot lights up and the header
 * makes room again; dropped there, the bar glides into it.
 *
 * While it is dragged the bar is the collapsed dot (`suppressed`): the expanded
 * row would only be in the way, and it stays collapsed after the drop until the
 * pointer comes back to it.
 *
 * Its place is one per browser (`useBarPlace`): the host is mounted once at the
 * root, so the bar stays where it was put across apps and surface modes.
 */
function FloatingBar({
  children,
}: {
  children: (growFrom: GrowFrom, dragging: boolean) => ReactNode;
}) {
  const [place, setPlace] = useBarPlace();
  const viewport = useViewportSize();
  const [drag, setDragState] = useState<Drag | null>(null);
  // The live drag as of the last pointer move, for the drop: the release can
  // arrive before React has rendered that move.
  const dragNow = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragNow.current = next;
    setDragState(next);
  };
  // Dropped on the home slot: the bar glides from the drop point to the slot,
  // then is home.
  const [settling, setSettling] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // The collapsed footprint (FloatingAction pins its hitbox to it, so it holds
  // still while the panel is open). The home slot is drawn at this size.
  const hitboxRef = useRef<HTMLDivElement>(null);
  const [footprint, setFootprint] = useState({ width: 0, height: 0 });
  useResizeObserver(hitboxRef, () => {
    const el = hitboxRef.current;
    if (!el) return;
    // Layout size, not the drawn box: the hitbox is scaled up while dragged.
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    setFootprint((was) =>
      was.width === width && was.height === height ? was : { width, height },
    );
  });
  const slotRef = useRef<HTMLDivElement>(null);
  // Where in the collapsed dot the pointer holds it, from the dot's centre.
  const grab = useRef<Point>({ x: 0, y: 0 });

  // The header reserves the slot while the bar is in it or settling into it,
  // and mid-drag while the bar hovers it — so the header's actions make way
  // before the drop, and glide back out as soon as the bar leaves.
  const reserve = drag ? drag.overHome : place.kind === "home" || !!settling;
  const safeAreaRef = useFloatingBarSafeArea(reserve);

  const startDrag = useDragGesture({
    onStart: (from) => {
      const hitbox = hitboxRef.current?.getBoundingClientRect();
      if (!hitbox) return;
      const c = centreOf(hitbox);
      // A press on the open row, away from the dot, carries the dot under the
      // pointer.
      grab.current = {
        x: clamp(from.x - c.x, -hitbox.width / 2, hitbox.width / 2),
        y: clamp(from.y - c.y, -hitbox.height / 2, hitbox.height / 2),
      };
      setSettling(null);
      setDrag({ cx: c.x, cy: c.y, overHome: place.kind === "home" });
    },
    onMove: ({ x, y }) => {
      const { width, height } = footprint;
      const cx = clamp(
        x - grab.current.x,
        EDGE_GAP_PX + width / 2,
        window.innerWidth - EDGE_GAP_PX - width / 2,
      );
      const cy = clamp(
        y - grab.current.y,
        EDGE_GAP_PX + height / 2,
        window.innerHeight - EDGE_GAP_PX - height / 2,
      );
      const slot = slotRef.current?.getBoundingClientRect();
      const home = slot ? centreOf(slot) : null;
      const overHome =
        home !== null && Math.hypot(cx - home.x, cy - home.y) <= SNAP_RADIUS_PX;
      setDrag({ cx, cy, overHome });
    },
    onEnd: () => {
      const drag = dragNow.current;
      setDrag(null);
      if (!drag) return;
      const slot = slotRef.current?.getBoundingClientRect();
      if (drag.overHome && slot) {
        const left = drag.cx - footprint.width / 2;
        const top = drag.cy - footprint.height / 2;
        // Already in place: nothing to glide (no transition would end it).
        if (Math.hypot(left - slot.left, top - slot.top) < 1)
          setPlace({ kind: "home" });
        else setSettling({ left: slot.left, top: slot.top });
        return;
      }
      setPlace({
        kind: "free",
        x: drag.cx / window.innerWidth,
        y: drag.cy / window.innerHeight,
      });
    },
  });

  // Where the bar is drawn when it is not at home: its collapsed footprint's
  // top-left corner, kept inside the viewport.
  let box: { left: number; top: number } | null = null;
  if (settling) box = settling;
  else if (drag)
    box = {
      left: drag.cx - footprint.width / 2,
      top: drag.cy - footprint.height / 2,
    };
  else if (place.kind === "free")
    box = {
      left: clamp(
        place.x * viewport.w - footprint.width / 2,
        EDGE_GAP_PX,
        viewport.w - EDGE_GAP_PX - footprint.width,
      ),
      top: clamp(
        place.y * viewport.h - footprint.height / 2,
        EDGE_GAP_PX,
        viewport.h - EDGE_GAP_PX - footprint.height,
      ),
    };
  // The open row grows away from the nearer screen edge: leftward at home and
  // on the right half, rightward on the left half.
  const growFrom: GrowFrom =
    box && box.left + footprint.width / 2 < viewport.w / 2 ? "left" : "right";

  return (
    <>
      {/* The home slot: the bar's collapsed footprint at its home corner, on
          the anchored band. It is the room the header reserves, and while the
          bar is dragged it outlines where the bar snaps back to. */}
      <div
        ref={safeAreaRef}
        aria-hidden
        // eslint-disable-next-line layout/no-adhoc-layout -- viewport-edge fixed band anchored to the surface-edge header (outside any transformed ancestor): the bar's home
        className="floating-bar-band pointer-events-none fixed right-3 z-popover flex flex-col"
      >
        <div
          ref={slotRef}
          // eslint-disable-next-line layout/no-adhoc-layout -- the home slot's outline, centred on the anchored band as the bar's hitbox is
          className={cn(
            "my-auto shrink-0 rounded-full border border-dashed transition-[opacity,background-color,border-color] duration-150",
            drag ? "opacity-100" : "opacity-0",
            drag?.overHome
              ? "border-primary bg-primary/15"
              : "border-foreground/30",
          )}
          style={{ width: footprint.width, height: footprint.height }}
        />
      </div>
      <div
        onPointerDown={startDrag}
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget || !settling) return;
          setSettling(null);
          setPlace({ kind: "home" });
        }}
        // eslint-disable-next-line layout/no-adhoc-layout -- viewport-fixed band: at home anchored to the surface-edge header, elsewhere at the user's drop point (outside any transformed ancestor)
        className={cn(
          "fixed z-popover flex touch-none flex-col",
          !box && "floating-bar-band right-3",
          drag && "cursor-grabbing select-none",
          settling &&
            "transition-[left,top] duration-300 ease-[cubic-bezier(0.2,0.9,0.25,1.15)]",
          BAR_TONE,
        )}
        style={box ?? undefined}
      >
        <div
          ref={hitboxRef}
          // eslint-disable-next-line layout/no-adhoc-layout -- the hitbox, centred on the anchored band at home (`my-auto`); `shrink-0` so the zero-height fallback band cannot squash it
          className={cn(
            "my-auto shrink-0 transition-transform duration-150",
            drag && "scale-110",
          )}
        >
          {children(growFrom, drag !== null)}
        </div>
      </div>
    </>
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
    // glass capsule (pill, `2xs` = 2px padding around the 32px `md` controls,
    // so 36px tall) that is there collapsed and open alike.
    <Theme name={chromeThemeScope} surface="none">
      <FloatingBar>
        {(growFrom, dragging) => (
          <FloatingAction
            // `relative` so the morphing panel anchors to this hitbox.
            className="relative"
            // The open row grows away from the screen edge the bar is nearer.
            anchor={growFrom === "right" ? "top-right" : "top-left"}
            // Moved, the bar is the collapsed dot (and stays so after the drop
            // until the pointer comes back to it).
            suppressed={dragging}
            variant="glass"
            shape="pill"
            pad="2xs"
            // No gap between the trigger and the reveal strip: the strip is a
            // zero-width flex item while collapsed, and a gap would still widen
            // the capsule by its width. The strip opens its own 2px lead instead.
            gap="none"
            // Every control is the same `md` height, so centring keeps each one
            // on the capsule's centre line — the dot, the glance chips and the
            // row's items alike — as the panel widens.
            align="center"
            trigger={(open) => <FloatingTrigger open={open} />}
          >
            {/* eslint-disable-next-line layout/no-adhoc-layout -- animated max-width hover-reveal strip (clipped while collapsed) */}
            <FloatingActionFadeIn className="flex max-w-0 items-center gap-2xs overflow-hidden group-data-open/fa:pl-2xs whitespace-nowrap transition-[max-width] duration-200 group-data-open/fa:max-w-[80rem]">
              <ActionBar.Item.Render controlSize={FLOATING_SIZE} />
            </FloatingActionFadeIn>
          </FloatingAction>
        )}
      </FloatingBar>
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
