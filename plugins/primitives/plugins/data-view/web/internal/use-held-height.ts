import { useLayoutEffect, useRef, useState } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

/**
 * The room the view's rows last took, in px — measured on the body's rows box
 * only while it shows the view (`showingView`), so it still holds the last
 * view's height once the body falls back to its loading state. `null` until
 * the view has been shown once.
 *
 * The body sizes its loading state at least this tall: a query that starts
 * over (a view switch, a filter or sort change) would otherwise swap the rows
 * for a few skeleton lines, the page would shrink under a reader scrolled
 * down, and the scroller would clamp them up — a jump the rows landing a
 * moment later never undo. The same invariant as a released page's
 * placeholder: what stands in for rows takes their room.
 */
export function useHeldHeight(
  host: HTMLElement | null,
  showingView: boolean,
): number | null {
  // The latest measure lives in a ref while the view shows: nothing renders
  // it then, and committing it re-rendered the whole body — every row — on
  // each frame the rows box resized (a window being resized reflows a card
  // grid every frame). It becomes state only when the body leaves the view,
  // the one render that reads it, before that frame paints.
  const lastHeight = useRef<number | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  useResizeObserver(
    () => host,
    () => {
      if (!showingView || host === null) return;
      lastHeight.current = host.getBoundingClientRect().height;
    },
    // Re-measure as the view comes back (its first frame is the room it takes).
    { deps: [host, showingView] },
  );
  useLayoutEffect(() => {
    if (!showingView) setHeld(lastHeight.current);
  }, [showingView]);
  return held;
}
