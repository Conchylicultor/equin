import {
  useCallback,
  useRef,
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

/**
 * Resolve where the pointer currently sits for a tab-chip drag: over a window's
 * tab-strip drop-zone (`data-floating-window-id`) with the computed insertion
 * index among that strip's chips, or `desktop` (empty backdrop). The insertion
 * index counts every chip whose horizontal midpoint is left of the cursor —
 * including the dragged chip's own slot, so an unmoved same-strip drop resolves
 * back to its current index (a no-op the store guards).
 */
function resolveDrop(x: number, y: number): TabDragDrop {
  const el = document.elementFromPoint(x, y);
  const strip = el?.closest<HTMLElement>("[data-floating-window-id]");
  if (!strip) return { kind: "desktop" };
  const windowId = strip.dataset.floatingWindowId!;
  const chips = strip.querySelectorAll<HTMLElement>("[data-floating-tab-id]");
  let index = 0;
  for (const chip of chips) {
    const r = chip.getBoundingClientRect();
    if (x > r.left + r.width / 2) index += 1;
  }
  return { kind: "strip", windowId, index };
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
 * desktop. Hit-testing + insertion-index live in {@link resolveDrop}; the live
 * ghost, insertion mark and tear-off preview are painted by the desktop-level
 * {@link TabDragOverlay}. A plain click (no threshold crossed) still selects.
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
  const single = members.length === 1;

  // Begin tracking a potential chip drag. A click still selects: we only commit
  // to a drag once the pointer moves past DRAG_THRESHOLD, and we suppress the
  // trailing click in that case. Window listeners (not pointer capture) so the
  // drag keeps tracking even when the cursor leaves the chip.
  const onChipPointerDown = useCallback(
    (e: ReactPointerEvent, member: WindowMember) => {
      // A chip never starts the window move-drag.
      e.stopPropagation();
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const tearSize = {
        w: Math.min(windowSize.w, TEAR_MAX.w),
        h: Math.min(windowSize.h, TEAR_MAX.h),
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          if (
            Math.hypot(ev.clientX - startX, ev.clientY - startY) <
            DRAG_THRESHOLD
          )
            return;
          dragging = true;
          startTabDrag({
            tabId: member.tabId,
            sourceWindowId: windowId,
            pointer: { x: ev.clientX, y: ev.clientY },
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
        endTabDrag();
        if (drop.kind === "desktop") {
          // Desktop-relative box: the strip → titlebar → tab container →
          // backdrop chain. Walk up from this window's strip to the shared
          // backdrop and subtract its rect so the new window lands where the
          // tear-off preview was drawn.
          const strip = document.querySelector<HTMLElement>(
            `[data-floating-window-id="${CSS.escape(windowId)}"]`,
          );
          const backdrop =
            strip?.closest<HTMLElement>("[data-tab-id]")?.parentElement ?? null;
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

  return (
    <>
      {members.map((member) => {
        const active = member.tabId === activeTabId;
        // The dragged chip fades in its source strip while the drag is live.
        const dragged =
          session?.tabId === member.tabId &&
          session.sourceWindowId === windowId;
        return (
          <Line
            key={member.tabId}
            role="tab"
            aria-selected={active}
            data-floating-tab-id={member.tabId}
            title={member.title}
            onPointerDown={(e: ReactPointerEvent) =>
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
            )}
            // The shown chip never shrinks; the others give way first.
            style={{ ...CHIP_STYLE, flex: active ? "0 0 auto" : "0 1 auto" }}
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
