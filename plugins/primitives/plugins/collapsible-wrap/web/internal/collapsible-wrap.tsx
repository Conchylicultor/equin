import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useEditMode } from "@plugins/primitives/plugins/edit-mode-signal/web";
import { ReorderLayoutContext, type ReorderLayout } from "@plugins/reorder/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const keyboardArrowUpIcon = symbol("keyboard-arrow-up");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");

export interface CollapsibleWrapProps {
  /** The single <Slot.Render> element — never indexed or duplicated. */
  children: ReactNode;
  /** Visible rows when collapsed; default 1. */
  rows?: number;
  /** Gap between chips in pixels; default 4 (= gap-1). */
  gap?: number;
  className?: string;
}

/** Popover panel inset (px) around the spilled rows in the expanded state. */
const PANEL_PAD = 6;

/** Collect effective flex children, walking through `display:contents`. */
function effectiveChildren(parent: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const ch of Array.from(parent.children) as HTMLElement[]) {
    if (getComputedStyle(ch).display === "contents") {
      out.push(...effectiveChildren(ch));
    } else {
      out.push(ch);
    }
  }
  return out;
}

/**
 * Uniform row height = the tallest effective child across ALL rows. Using a
 * global max (rather than only the first row) keeps the collapse clamp stable
 * when a taller chip wraps to row 2 — otherwise the clamp would shrink/grow as
 * the tallest chip moves between rows, producing a few-px vertical shift at the
 * collapse boundary. Walks through `display:contents` reorder wrappers so a
 * zero-height wrapper never collapses the clamp to 0, and filters dnd-kit's
 * zero-area / off-screen measuring artifacts (offsetHeight <= 1, offsetWidth 0).
 */
function uniformRowHeight(wrap: HTMLElement): number {
  const children = effectiveChildren(wrap).filter(
    (c) => c.offsetHeight > 1 && c.offsetWidth > 0,
  );
  if (children.length === 0) return 0;
  let h = 0;
  for (const c of children) h = Math.max(h, c.offsetHeight);
  return h;
}

export function CollapsibleWrap({
  children,
  rows = 1,
  gap = 4,
  className,
}: CollapsibleWrapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  const [overflowing, setOverflowing] = useState(false);
  const [clampHeight, setClampHeight] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [userExpanded, setUserExpanded] = useState(false);

  const editMode = useEditMode();
  const expanded = userExpanded || editMode;

  // Tell the reorder middleware this row wraps: its layout editor then drags
  // in 2-D, so cross-row drag works once chips spill onto multiple rows. Stable
  // identity so the middleware's context consumer doesn't churn. The spacer is
  // unchanged from the 1-D case — a `flex-1` push element behaves identically
  // under wrap (it grows to fill its line, pushing chips right until they wrap).
  const wrapLayout = useMemo<ReorderLayout>(() => ({ flow: "wrap" }), []);

  // --- Overflow + clamp-height detection ------------------------------------
  // Mirror adaptive-bar: ResizeObserver on the wrap box, deferred via
  // requestAnimationFrame. No timers/polling. We track both the 1-row clamp
  // height (the box's fixed layout height in BOTH states) and the full content
  // height (used to size the expanded popover backdrop).
  useResizeObserver(
    wrapRef,
    () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      // The reorder middleware wraps each contribution; in view mode those
      // wrappers are `display:contents` (offsetHeight 0). Walk through them to
      // the real boxes and take a uniform (global-max) row height.
      const rowHeight = uniformRowHeight(wrap);
      if (rowHeight === 0) {
        setOverflowing(false);
        setClampHeight(null);
        setContentHeight(0);
        return;
      }
      const clamp = rowHeight * rows + gap * (rows - 1);
      setClampHeight(clamp);
      setContentHeight(wrap.scrollHeight);
      setOverflowing(wrap.scrollHeight > clamp + 1);
    },
    { deps: [rows, gap, expanded] },
  );

  const collapse = useCallback(() => setUserExpanded(false), []);
  const expand = useCallback(() => setUserExpanded(true), []);

  // --- Layout: in-flow in both states, row 1 never moves --------------------
  // The box's LAYOUT height is `clampHeight` (one row) in BOTH collapsed and
  // expanded — only `overflow` flips. Because the layout height is identical,
  // the host band's `items-center` centers exactly one row the same way in both
  // states, so row 1 is pixel-stable. Collapsed clips the extra rows; expanded
  // reveals them — they spill DOWN over the content below (no ancestor between
  // here and there may clip — see the host contract in CLAUDE.md). A maxHeight-
  // clamped box's own background can't paint overflowing content, so a measured
  // absolute backdrop draws the popover panel behind the spilled rows.
  const style: CSSProperties =
    clampHeight === null
      ? { gap }
      : {
          gap,
          maxHeight: clampHeight,
          overflow: expanded ? "visible" : "hidden",
        };

  const showBackdrop = expanded && overflowing && clampHeight !== null;

  // Outer = positioning context (holds the backdrop + the stacking lift); inner
  // (`wrapRef`) = the measured flex-wrap box holding ONLY the chips. The backdrop
  // is sized FROM the inner's measurements, so it must NOT live inside the
  // measured element — otherwise `uniformRowHeight()`/`scrollHeight` would count
  // it as content, inflating the clamp, resizing the box, re-firing the
  // ResizeObserver, and oscillating row 1 between two positions. Keeping it a
  // sibling of `wrapRef` breaks that feedback path by construction.
  const wrapBox = (
    // eslint-disable-next-line layout/no-adhoc-layout -- flexible leaf of the host's chip-row flex; min-w-0 flex-1 lets the measured wrap box fill and shrink
    <div className={cn("relative min-w-0 flex-1", expanded && "z-popover")}>
      {showBackdrop && (
        <Surface
          level="overlay"
          aria-hidden
          // eslint-disable-next-line layout/no-adhoc-layout, z-layers/no-adhoc-zindex -- JS-measured backdrop positioned via computed inline top/left/right/height, so no semantic-ramp anchor applies; `-z-10` paints it BEHIND its own parent, and the z-layers scale (z-raised..z-max) is all positive by design — there is no negative rung to reach for
          className="pointer-events-none absolute -z-10"
          style={{
            top: -PANEL_PAD,
            left: -PANEL_PAD,
            right: -PANEL_PAD,
            height: contentHeight + PANEL_PAD * 2,
          }}
        />
      )}
      <div
        ref={wrapRef}
        // eslint-disable-next-line layout/no-adhoc-layout -- ResizeObserver-measured flex-wrap clip box; the flex-wrap/content-start/min-w-0 mechanics are integral to the row-clamp behavior and have no primitive equivalent
        className={cn("flex flex-wrap content-start min-w-0", className)}
        style={style}
      >
        <ReorderLayoutContext.Provider value={wrapLayout}>
          {children}
        </ReorderLayoutContext.Provider>
      </div>
    </div>
  );

  const showChevron = (overflowing || expanded) && !editMode;

  return (
    <>
      {wrapBox}
      {showChevron && (
        <IconButton
          icon={expanded ? keyboardArrowUpIcon : keyboardArrowDownIcon}
          label={expanded ? "Collapse" : "Expand"}
          // eslint-disable-next-line layout/no-adhoc-layout -- rigid chevron affordance in the host's chip-row flex; must not shrink alongside the wrap box
          className="shrink-0"
          onClick={expanded ? collapse : expand}
        />
      )}
    </>
  );
}
