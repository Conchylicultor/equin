import {
  cn,
  SidewaysScrollProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type React from "react";
import "./scroll.css";

/**
 * Which axis (or axes) scrolls. `y` and `x` clamp the perpendicular axis to
 * `hidden` so a vertical scroller never grows a stray horizontal bar (and vice
 * versa); `both` opens both axes.
 */
export type ScrollAxis = "y" | "x" | "both";

const OVERFLOW_CLASS: Record<ScrollAxis, string> = {
  // A vertical scroller ALSO scrolls sideways while it holds content marked
  // `data-scrolls-x` — a grid table wider than its box (data-table), which
  // marks the boxes up to here `data-scroll-x-path` (`useScrollsSideways`),
  // this one included: the scroller keys on its own mark, not a `:has()`. The pane
  // stays the one scroller on both axes, so the table's sticky header (top)
  // and first column (left) pin to the same scroller; a scroller of the
  // table's own would capture the header's `top`. Meanwhile it is an
  // inline-size container, so a band pinned to its left edge sizes itself to
  // what is visible (`max-width: 100cqi`). Unmarked, nothing changes.
  y: "overflow-y-auto overflow-x-hidden data-scroll-x-path:overflow-x-auto data-scroll-x-path:[container-type:inline-size]",
  x: "overflow-x-auto overflow-y-hidden",
  both: "overflow-auto",
};

/**
 * The pure overflow + fill class map — the single source of truth for Scroll's
 * geometry, exported so the component and the pure test share one definition.
 *
 * `fill` emits the flex-child fill pair as ONE concern: a scroll pane inside a
 * flex column must be both `flex-1` (claim the leftover main-axis space) AND
 * `min-h-0` (allow shrinking below content height so the overflow actually
 * engages). Splitting `min-h-0` out re-exposes the "pane grows past its parent,
 * the whole page scrolls instead" footgun — so they live together. On a
 * horizontal scroller (`axis: "x"`) the same role is `min-w-0 flex-1`.
 */
export function scrollClasses(opts: {
  axis: ScrollAxis;
  fill: boolean;
  hideScrollbar: boolean;
  isolate: boolean;
}): string {
  return [
    OVERFLOW_CLASS[opts.axis],
    opts.fill
      ? opts.axis === "x"
        ? "min-w-0 flex-1"
        : "min-h-0 flex-1"
      : null,
    opts.hideScrollbar ? "no-scrollbar" : null,
    opts.isolate ? "isolate" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ScrollProps extends React.HTMLAttributes<HTMLElement> {
  /** Which axis scrolls. Defaults to `y`. */
  axis?: ScrollAxis;
  /** Emit the flex-child fill pair (`min-h-0 flex-1`, or `min-w-0 flex-1` on the
   *  `x` axis) so the pane fills its flex parent and the overflow engages.
   *  Defaults to false. */
  fill?: boolean;
  /** Hide the scrollbar chrome while keeping the content scrollable
   *  (`no-scrollbar`). Defaults to false. */
  hideScrollbar?: boolean;
  /** Open a new stacking context (`isolate`) so descendant z-layers can't escape
   *  the pane. Defaults to false. */
  isolate?: boolean;
  /** Host element/component. Defaults to a `div`. */
  as?: React.ElementType;
  /** Forwarded to the rendered element (mirrors Surface/Card/Row). */
  ref?: React.Ref<HTMLElement>;
  /**
   * `y` axis: make this scroller a bleed region — a sideways scroller marked
   * `bleed` anywhere inside it may grow past its own column, up to this
   * scroller's width. Set it on a pane whose content is a centred column
   * narrower than the pane (a transcript's reading measure).
   *
   * `x` axis: this sideways scroller bleeds — inside a bleed region it is as
   * wide as the region, its content centred on the column it sits in, growing
   * past the column on both sides as far as the region allows and scrolling
   * sideways only beyond that. Its content is never narrower than the column.
   * Outside a region it stays the column's width.
   */
  bleed?: boolean;
}

/**
 * The sanctioned scroll-container primitive — owns overflow AND the flex-child
 * fill policy as a single role, the combination ~100 call sites re-derived by
 * hand as `min-h-0 flex-1 overflow-y-auto`. Supersedes the old "a genuine scroll
 * container is the canonical eslint-disable" guidance: reach for `<Scroll>`.
 *
 * Sizing stays in the caller's `className` — `h-*`/`max-h-*` are not banned, so a
 * fixed-height scroller is `<Scroll className="max-h-96">` and a full-height one
 * is `<Scroll className="h-full">`. The primitive owns only the overflow + fill
 * mechanics; the box's extent is the caller's concern.
 *
 * Caller `className` composes last.
 */
export function Scroll({
  axis = "y",
  fill = false,
  hideScrollbar = false,
  isolate = false,
  as: As = "div",
  ref,
  bleed = false,
  className,
  children,
  ...rest
}: ScrollProps) {
  const bleeds = bleed && axis === "x";
  const scroller = (
    <As
      ref={ref}
      className={cn(
        scrollClasses({ axis, fill, hideScrollbar, isolate }),
        bleeds ? null : className,
      )}
      // A vertical scroller is where a wide grid table may scroll sideways
      // (it opens the `SidewaysScroll` region below); the mark is what this
      // plugin's CSS keys the pinning of everything else on, and what the
      // table checks is the box actually clipping it.
      data-scroll-x-host={axis === "y" ? "" : undefined}
      // Bleed: the region and the bleeding scroller are keyed on in scroll.css.
      data-bleed-region={bleed && axis === "y" ? "" : undefined}
      data-bleed={bleeds ? "" : undefined}
      {...rest}
    >
      {axis === "y" ? (
        <SidewaysScrollProvider value={true}>{children}</SidewaysScrollProvider>
      ) : bleeds ? (
        <div data-bleed-content="">{children}</div>
      ) : (
        children
      )}
    </As>
  );
  // A bleeding scroller sits in a column-wide anchor (scroll.css), which
  // takes the caller's className: the box in the flow is the anchor.
  return bleeds ? (
    <div data-bleed-anchor="" className={className}>
      {scroller}
    </div>
  ) : (
    scroller
  );
}
