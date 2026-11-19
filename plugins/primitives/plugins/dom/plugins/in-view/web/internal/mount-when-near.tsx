import { useEffect, useRef, useState, type ReactNode } from "react";

import { createInViewWatcher } from "./in-view";

export type MountWhenNearProps = {
  /** What to mount once the box first comes near the visible part of its scroller. */
  children: ReactNode;
  /**
   * Drawn until then, in the content's place. Give it about the height the
   * content will take: a fallback much shorter than the content brings every
   * later box near at once, which is the cost this component exists to avoid.
   */
  fallback: ReactNode;
  /**
   * How far outside the scroller's visible box still counts as near
   * (IntersectionObserver `rootMargin`; percentages are of the scroller).
   * Default: half a scroller below and above, so content is usually drawn
   * before it scrolls into sight.
   */
  rootMargin?: string;
  /**
   * The scroller the box scrolls in, found from the box itself (e.g.
   * auto-scroll's `findScrollParent`). A margin only extends the ROOT's box:
   * with the viewport as root, an inner scroller's clip still hides everything
   * below its edge, so the margin would do nothing. Omitted: the viewport.
   * Pass a stable (module-level) function — a new one rebuilds the observer.
   */
  scrollRoot?: (box: HTMLElement) => Element | null;
};

/**
 * Mounts `children` only once its box comes near the visible part of its
 * scroller, then keeps them mounted (a one-way latch: scrolling away never
 * unmounts, so the content's own state survives).
 *
 * For a long surface stacking many heavy, independent sections (a dashboard
 * of charts): mounting all of them at once makes the page's first frames pay
 * for everything below the fold — what it costs to open becomes O(sections)
 * instead of O(what is on screen). Each section's own reads start when it
 * mounts too, so a section nobody scrolls to costs neither the main thread
 * nor the server.
 *
 * Until a section mounts, find-in-page and print do not see it.
 *
 * Not a virtualizer: a mounted section stays mounted. For a long list of
 * uniform rows, use `primitives/virtual-rows`.
 */
export function MountWhenNear({
  children,
  fallback,
  rootMargin = "50% 0px",
  scrollRoot,
}: MountWhenNearProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (near) return;
    const box = boxRef.current;
    if (box === null) return;
    const found = scrollRoot?.(box) ?? null;
    // The document's own scroller is the window, not a box: as an observer
    // root `<html>` measures against its whole (unclipped) height, so every
    // box would count as near at once.
    const root =
      found === document.scrollingElement || found === document.documentElement
        ? null
        : found;
    const watcher = createInViewWatcher(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root, rootMargin },
    );
    watcher.observe(box);
    return () => watcher.disconnect();
  }, [near, rootMargin, scrollRoot]);

  return <div ref={boxRef}>{near ? children : fallback}</div>;
}
