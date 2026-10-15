import { useLayoutEffect } from "react";

/** How many marked boxes each path box lies above: two wide tables in one
 *  pane share their path from the pane down to where they part. */
const pathMarks = new WeakMap<HTMLElement, number>();

/**
 * Declares that `box` is wider than its pane and scrolls it sideways, while
 * `active`: the box is marked `data-scrolls-x` (the enclosing `Scroll` opens its
 * horizontal overflow) and every box from it up to that `Scroll` — the scroller
 * included — `data-scroll-x-path`, which `scroll.css` keys on: the path grows to
 * the box and everything off it pins to the visible left edge.
 *
 * The path is named by the box, not found by the stylesheet. A selector that
 * found it (`… :has([data-scrolls-x])` on an unanchored compound) made every
 * element in every pane a `:has()` subject, so ANY insertion in a pane — a fold
 * mounting its content, a live row — restyled the whole pane: hundreds of
 * milliseconds on a long transcript, before the fold could move.
 *
 * Only a box inside a `Scroll` (`data-scroll-x-host`) may be marked; one that
 * is not is a broken assumption, and throws.
 */
export function useScrollsSideways(
  box: HTMLElement | null,
  active: boolean,
): void {
  useLayoutEffect(() => {
    if (!active || box === null) return;
    const path: HTMLElement[] = [];
    let host: HTMLElement | null = null;
    for (let n = box.parentElement; n; n = n.parentElement) {
      path.push(n);
      if (n.hasAttribute("data-scroll-x-host")) {
        host = n;
        break;
      }
    }
    if (host === null)
      throw new Error(
        "useScrollsSideways: the box is not inside a <Scroll> (data-scroll-x-host)",
      );
    box.setAttribute("data-scrolls-x", "");
    for (const el of path) {
      pathMarks.set(el, (pathMarks.get(el) ?? 0) + 1);
      el.setAttribute("data-scroll-x-path", "");
    }
    return () => {
      box.removeAttribute("data-scrolls-x");
      for (const el of path) {
        const left = (pathMarks.get(el) ?? 1) - 1;
        if (left > 0) {
          pathMarks.set(el, left);
          continue;
        }
        pathMarks.delete(el);
        el.removeAttribute("data-scroll-x-path");
      }
    };
  }, [box, active]);
}
