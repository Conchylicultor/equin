import { announceNavigation } from "./announce-navigation";

export type ScrollAlign = "start" | "center" | "end" | "nearest";

export interface ScrollChildIntoViewOptions {
  /** Vertical alignment of the child within the container. Omit to leave the
   *  vertical scroll position untouched. */
  block?: ScrollAlign;
  /** Horizontal alignment. Omit to leave the horizontal scroll position alone. */
  inline?: ScrollAlign;
  behavior?: ScrollBehavior;
}

function alignTarget(
  currentScroll: number,
  childStart: number,
  childSize: number,
  viewSize: number,
  align: ScrollAlign,
): number {
  switch (align) {
    case "start":
      return childStart;
    case "center":
      return childStart - (viewSize - childSize) / 2;
    case "end":
      return childStart - (viewSize - childSize);
    case "nearest": {
      const childEnd = childStart + childSize;
      const viewEnd = currentScroll + viewSize;
      if (childStart < currentScroll) return childStart;
      if (childEnd > viewEnd) return childEnd - viewSize;
      return currentScroll;
    }
  }
}

/**
 * Scroll ONLY `container` so `child` is aligned within it — never touching any
 * ancestor's scroll position. The container-scoped counterpart to scroll-reveal's
 * `revealElement`, which uses `scrollIntoView` and therefore scrolls every
 * scrollable ancestor up the chain to bring the element on screen. Use this when
 * a single bounded surface must follow its own content while everything around it
 * stays put (e.g. a self-scrolling lead-sheet strip nested inside a scrollable
 * pane).
 *
 * Only the axes you pass move: pass `block` to scroll vertically, `inline` to
 * scroll horizontally; omit an axis to leave that scroll offset untouched.
 * Rect-based (not offsetTop), so it is independent of the child's offsetParent.
 * Honours the child's CSS `scroll-margin`, as native `scrollIntoView` does — so a
 * section under a pinned header declares `scroll-margin-top` once and every
 * jump to it lands below the bar.
 */
export function scrollChildIntoView(
  container: HTMLElement | null | undefined,
  child: HTMLElement | null | undefined,
  opts?: ScrollChildIntoViewOptions,
): void {
  if (!container || !child) return;
  const cRect = container.getBoundingClientRect();
  const chRect = child.getBoundingClientRect();
  const to: ScrollToOptions = { behavior: opts?.behavior ?? "auto" };
  const style =
    opts?.block || opts?.inline ? getComputedStyle(child) : undefined;
  const margin = (side: "Top" | "Bottom" | "Left" | "Right") =>
    parseFloat(style?.[`scrollMargin${side}`] ?? "") || 0;

  if (opts?.block) {
    const childTop =
      container.scrollTop + (chRect.top - cRect.top) - margin("Top");
    const raw = alignTarget(
      container.scrollTop,
      childTop,
      chRect.height + margin("Top") + margin("Bottom"),
      container.clientHeight,
      opts.block,
    );
    to.top = Math.max(
      0,
      Math.min(raw, container.scrollHeight - container.clientHeight),
    );
  }
  if (opts?.inline) {
    const childLeft =
      container.scrollLeft + (chRect.left - cRect.left) - margin("Left");
    const raw = alignTarget(
      container.scrollLeft,
      childLeft,
      chRect.width + margin("Left") + margin("Right"),
      container.clientWidth,
      opts.inline,
    );
    to.left = Math.max(
      0,
      Math.min(raw, container.scrollWidth - container.clientWidth),
    );
  }
  announceNavigation(container);
  container.scrollTo(to);
}
