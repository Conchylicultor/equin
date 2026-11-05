import {
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { DesktopTileApp } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  endTabDrag,
  startTabDrag,
  updateTabDrag,
  useTabDragSession,
  type TabDragDrop,
} from "../hooks/use-tab-drag";
import {
  chipShifts,
  clampDraggedOffset,
  insertionIndex,
  type StripSlots,
} from "../internal/tab-strip-layout";

const addIcon = symbol("add");
const closeIcon = symbol("close");

/** One member's display data for a tab-strip chip. */
export interface WindowMember {
  tabId: string;
  title: string;
  /** The member's app — the drag ghost's tile. */
  app: DesktopTileApp | undefined;
}

/** The commit operations a finished chip drag invokes (resolved by the host). */
export interface TabDragCommit {
  /** Reorder a member within this same window's strip. */
  reorder: (tabId: string, index: number) => void;
  /** Merge a member into another window's strip at an index. */
  merge: (tabId: string, targetWindowId: string, index: number) => void;
  /** Tear a member off into a new window at a desktop-relative box. */
  split: (
    tabId: string,
    box: { x: number; y: number; w: number; h: number },
  ) => void;
}

interface WindowTabStripProps {
  /** The window this strip belongs to (source of a drag started from it). */
  windowId: string;
  /** The window's current size — a tear-off opens at it (capped). */
  windowSize: { w: number; h: number };
  members: WindowMember[];
  activeTabId: string;
  /** Whether the window is the focused one (its shown chip reads stronger). */
  focused: boolean;
  /** Show + focus a member (click on its chip). */
  onSelect: (tabId: string) => void;
  /** Close a single member (the chip ×). */
  onCloseMember: (tabId: string) => void;
  /** Open a fresh tab as a new member of this window (the trailing `+`). */
  onNewTab: () => void;
  /** Commit ops for a finished chip drag (reorder / merge / split). */
  commit: TabDragCommit;
}

/** Movement (px) past which a chip pointer-down promotes from a click to a drag. */
const DRAG_THRESHOLD = 5;
/** Where the tear-off box sits under the pointer (mockup: 80px in, 16px down). */
const TEAR_OFFSET = { x: 80, y: 16 };
/** A tear-off never opens larger than this (mockup). */
const TEAR_MAX = { w: 640, h: 460 };

/**
 * The mockup's tab-chip metrics (`.tab`, `.tab-x`, `.tab-add`). Window chrome
 * drawn to the mockup's pixel, so the box values are literals here rather than
 * ramp steps (which follow the app's density).
 */
const CHIP_STYLE = {
  height: 28,
  padding: "0 3px 0 10px",
  borderRadius: 7,
  gap: 2,
  maxWidth: 210,
  minWidth: 56,
} as const;
const CHIP_X_STYLE = { width: 18, height: 18, borderRadius: 5 } as const;
const ADD_STYLE = { width: 26, height: 26, borderRadius: 6 } as const;

/** Vertical slack (px) above and below its own strip a drag still reorders within it. */
const OWN_STRIP_SLACK = 24;
/** How long the chips take to slide into a new arrangement (Chrome-like). */
const SHIFT_MS = 150;
const SHIFT_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function stripOf(windowId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-floating-window-id="${CSS.escape(windowId)}"]`,
  );
}

/** A strip's chips as laid out right now (viewport x), and its flex gap. */
function measureStrip(strip: HTMLElement): StripSlots {
  const slots = [
    ...strip.querySelectorAll<HTMLElement>("[data-floating-tab-id]"),
  ].map((chip) => {
    const r = chip.getBoundingClientRect();
    return { tabId: chip.dataset.floatingTabId!, left: r.left, width: r.width };
  });
  return { slots, gap: parseFloat(getComputedStyle(strip).columnGap) || 0 };
}

/**
 * The tab-drag hit test for one drag: where the pointer sits — a window's tab
 * strip (`data-floating-window-id`) with the insertion index among its members
 * minus the dragged one, or the empty `desktop`. Each strip is measured the
 * first time the drag reaches it, at rest, and kept for the drag: the index is
 * read against those resting slots, never against the shifts it caused. On its
 * own strip the index follows the dragged chip's centre (it slides with the
 * pointer, held within the row) and the drag keeps reordering a little above
 * and below the strip; elsewhere it follows the pointer.
 */
function createDropResolver(
  source: { windowId: string; tabId: string; strip: HTMLElement },
  origin: { x: number },
) {
  const measured = new Map<string, StripSlots>([
    [source.windowId, measureStrip(source.strip)],
  ]);
  const own = measured.get(source.windowId)!;
  const ownSlot = own.slots.find((s) => s.tabId === source.tabId);
  const ownBand = source.strip.getBoundingClientRect();

  return (x: number, y: number): TabDragDrop => {
    const inOwnBand =
      x >= ownBand.left &&
      x <= ownBand.right &&
      y >= ownBand.top - OWN_STRIP_SLACK &&
      y <= ownBand.bottom + OWN_STRIP_SLACK;
    const strip = inOwnBand
      ? source.strip
      : document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>("[data-floating-window-id]");
    if (!strip) return { kind: "desktop" };
    const windowId = strip.dataset.floatingWindowId!;
    let layout = measured.get(windowId);
    if (!layout) {
      layout = measureStrip(strip);
      measured.set(windowId, layout);
    }
    if (windowId === source.windowId && ownSlot) {
      const dx = clampDraggedOffset(layout.slots, source.tabId, x - origin.x);
      const center = ownSlot.left + ownSlot.width / 2 + dx;
      return {
        kind: "strip",
        windowId,
        index: insertionIndex(layout.slots, center, source.tabId),
        layout,
      };
    }
    return {
      kind: "strip",
      windowId,
      index: insertionIndex(layout.slots, x),
      layout,
    };
  };
}

/**
 * The in-window tab strip rendered inside {@link WindowChrome}'s titlebar — the
 * mockup's `.tabs`: one text chip per member (truncated title + close ×), the
 * shown one filled, and a trailing `+` that appears while the titlebar is
 * hovered. A single-member window reads as a plain title: its chip has no fill
 * and no × until hovered.
 *
 * Clicking a chip shows + focuses that member; the chip × closes that member
 * alone (the titlebar's close control closes the whole window). A chip
 * pointer-down never starts the titlebar's move-drag underneath.
 *
 * A chip body is also **draggable** (browser-style): pressing and moving past a
 * small threshold starts a cross-window drag that reorders within this strip,
 * merges onto another window's strip, or tears the tab off onto the empty
 * desktop. Like a browser's tab strip, the strip under the drag slides its
 * chips apart to open the gap the tab would land in, and on its own strip the
 * chip itself rides the pointer; a drop slides every chip into its new place.
 * Hit-testing + insertion-index live in {@link createDropResolver}; the ghost
 * (off its own strip), the merge target's highlight and the tear-off preview
 * are painted by the desktop-level {@link TabDragOverlay}. A plain click (no
 * threshold crossed) still selects.
 */
export function WindowTabStrip({
  windowId,
  windowSize,
  members,
  activeTabId,
  focused,
  onSelect,
  onCloseMember,
  onNewTab,
  commit,
}: WindowTabStripProps) {
  const session = useTabDragSession();
  // Set true on a completed drag so the trailing synthetic click (fired by the
  // browser after pointerup) doesn't also `onSelect` the moved tab.
  const draggedRef = useRef(false);
  // Each chip's on-screen left just before a drop on this strip commits: the
  // drop re-renders the chips in their new order with no shift, and the layout
  // effect below slides each from where it was shown to where it now is (FLIP).
  const settleFromRef = useRef<Map<string, number> | null>(null);
  const single = members.length === 1;
  const order = members.map((m) => m.tabId).join("\n");

  useLayoutEffect(() => {
    const from = settleFromRef.current;
    if (!from || session) return;
    settleFromRef.current = null;
    const strip = stripOf(windowId);
    if (!strip) return;
    for (const chip of strip.querySelectorAll<HTMLElement>(
      "[data-floating-tab-id]",
    )) {
      const was = from.get(chip.dataset.floatingTabId!);
      if (was === undefined) continue;
      const delta = was - chip.getBoundingClientRect().left;
      if (Math.abs(delta) < 0.5) continue;
      chip.animate(
        [{ transform: `translateX(${delta}px)` }, { transform: "none" }],
        { duration: SHIFT_MS, easing: SHIFT_EASE },
      );
    }
  }, [session, order, windowId]);

  // Begin tracking a potential chip drag. A click still selects: we only commit
  // to a drag once the pointer moves past DRAG_THRESHOLD, and we suppress the
  // trailing click in that case. Window listeners (not pointer capture) so the
  // drag keeps tracking even when the cursor leaves the chip.
  const onChipPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, member: WindowMember) => {
      // A chip never starts the window move-drag.
      e.stopPropagation();
      if (e.button !== 0) return;
      // No text selection: a press-and-drag on a chip moves the tab, it never
      // selects its title (or whatever text the pointer crosses).
      e.preventDefault();
      const strip = e.currentTarget.closest<HTMLElement>(
        "[data-floating-window-id]",
      );
      if (!strip) return;
      const origin = { x: e.clientX, y: e.clientY };
      const width = e.currentTarget.getBoundingClientRect().width;
      const resolveDrop = createDropResolver(
        { windowId, tabId: member.tabId, strip },
        origin,
      );
      let dragging = false;
      const tearSize = {
        w: Math.min(windowSize.w, TEAR_MAX.w),
        h: Math.min(windowSize.h, TEAR_MAX.h),
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          if (
            Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <
            DRAG_THRESHOLD
          )
            return;
          dragging = true;
          startTabDrag({
            tabId: member.tabId,
            sourceWindowId: windowId,
            pointer: { x: ev.clientX, y: ev.clientY },
            origin,
            width,
            label: member.title,
            app: member.app,
            tearSize,
            drop: resolveDrop(ev.clientX, ev.clientY),
          });
          return;
        }
        updateTabDrag({
          pointer: { x: ev.clientX, y: ev.clientY },
          drop: resolveDrop(ev.clientX, ev.clientY),
        });
      };

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (!dragging) return; // a plain click — let the chip's onClick select.
        draggedRef.current = true; // swallow the trailing synthetic click.
        const drop = resolveDrop(ev.clientX, ev.clientY);
        if (drop.kind === "strip" && drop.windowId === windowId) {
          // Settle from where the chips are shown now (shifts applied).
          settleFromRef.current = new Map(
            [
              ...strip.querySelectorAll<HTMLElement>("[data-floating-tab-id]"),
            ].map((chip) => [
              chip.dataset.floatingTabId!,
              chip.getBoundingClientRect().left,
            ]),
          );
        }
        endTabDrag();
        if (drop.kind === "desktop") {
          // Desktop-relative box: the strip → titlebar → tab container →
          // backdrop chain. Walk up from this window's strip to the shared
          // backdrop and subtract its rect so the new window lands where the
          // tear-off preview was drawn.
          const backdrop =
            strip.closest<HTMLElement>("[data-tab-id]")?.parentElement ?? null;
          const rect = backdrop?.getBoundingClientRect();
          commit.split(member.tabId, {
            x: ev.clientX - (rect?.left ?? 0) - TEAR_OFFSET.x,
            y: ev.clientY - (rect?.top ?? 0) - TEAR_OFFSET.y,
            ...tearSize,
          });
        } else if (drop.windowId === windowId) {
          commit.reorder(member.tabId, drop.index);
        } else {
          commit.merge(member.tabId, drop.windowId, drop.index);
        }
      };

      const onCancel = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        endTabDrag();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [windowId, windowSize.w, windowSize.h, commit],
  );

  // The live arrangement: over this strip, the other chips slide apart to open
  // the gap the tab would land in, and — on its own strip — the dragged chip
  // rides the pointer along the row. Off it, every chip rests in place and the
  // dragged one fades (the overlay's ghost carries it).
  const drop = session?.drop;
  const target = drop?.kind === "strip" && drop.windowId === windowId;
  const ownDrag = session?.sourceWindowId === windowId;
  const shifts =
    session && target
      ? chipShifts(drop.layout, drop.index, {
          tabId: ownDrag ? session.tabId : undefined,
          width: session.width,
        })
      : null;
  const chipMotion = (tabId: string): CSSProperties | null => {
    if (!session) return null;
    if (ownDrag && tabId === session.tabId) {
      if (!target) return null;
      const dx = clampDraggedOffset(
        drop.layout.slots,
        tabId,
        session.pointer.x - session.origin.x,
      );
      return {
        transform: `translateX(${dx}px)`,
        position: "relative",
        zIndex: 1,
      };
    }
    return {
      transform: `translateX(${shifts?.get(tabId) ?? 0}px)`,
      transition: `transform ${SHIFT_MS}ms ${SHIFT_EASE}`,
    };
  };

  return (
    <>
      {members.map((member) => {
        const active = member.tabId === activeTabId;
        // The dragged chip fades in its source strip while it is carried
        // elsewhere (on its own strip it rides the pointer instead).
        const dragged = ownDrag && session.tabId === member.tabId && !target;
        // Riding the pointer over its neighbours, it is an opaque card (the
        // ghost's) so the chip it passes over never shows through.
        const riding = ownDrag && session.tabId === member.tabId && target;
        return (
          <Line
            key={member.tabId}
            role="tab"
            aria-selected={active}
            data-floating-tab-id={member.tabId}
            title={member.title}
            onPointerDown={(e: ReactPointerEvent<HTMLElement>) =>
              onChipPointerDown(e, member)
            }
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              onSelect(member.tabId);
            }}
            className={cn(
              "group/tab text-control cursor-default",
              active
                ? cn(
                    "font-[550]",
                    focused ? "text-foreground" : "text-muted-foreground",
                    single
                      ? "hover:bg-hover-fill"
                      : focused
                        ? "bg-foreground/7"
                        : "bg-foreground/4",
                  )
                : "font-normal text-faint-foreground hover:bg-hover-fill hover:text-muted-foreground",
              dragged && "opacity-35",
              riding && "bg-card text-card-foreground shadow-md",
            )}
            // The shown chip never shrinks; the others give way first.
            style={{
              ...CHIP_STYLE,
              flex: active ? "0 0 auto" : "0 1 auto",
              ...chipMotion(member.tabId),
            }}
          >
            <Fill>
              <Text>{member.title}</Text>
            </Fill>
            <Center
              as="button"
              aria-label="Close tab"
              title="Close tab"
              onPointerDown={(e: ReactPointerEvent) => e.stopPropagation()}
              onClick={(e: ReactMouseEvent) => {
                e.stopPropagation();
                onCloseMember(member.tabId);
              }}
              className={cn(
                rigidClass(),
                "text-faint-foreground hover:bg-hover-fill hover:text-foreground",
                active && !single
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100",
              )}
              style={CHIP_X_STYLE}
            >
              <Icon icon={closeIcon} style={{ fontSize: 12 }} />
            </Center>
          </Line>
        );
      })}
      {/* Trailing new-tab affordance (mockup `.tab-add`): shown while the
          titlebar is hovered; opens a fresh tab as a new member of this window. */}
      <Center
        as="button"
        aria-label="New tab"
        title="New tab"
        onPointerDown={(e: ReactPointerEvent) => e.stopPropagation()}
        onClick={onNewTab}
        className={cn(
          rigidClass(),
          "pointer-events-none text-faint-foreground opacity-0 transition-opacity duration-120 hover:bg-hover-fill hover:text-foreground group-hover/titlebar:pointer-events-auto group-hover/titlebar:opacity-100",
        )}
        style={ADD_STYLE}
      >
        <Icon icon={addIcon} style={{ fontSize: 16 }} />
      </Center>
    </>
  );
}
