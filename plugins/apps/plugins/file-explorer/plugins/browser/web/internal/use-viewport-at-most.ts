import { useSyncExternalStore } from "react";

/**
 * Whether the viewport is at most `px` wide — the Files layout's breakpoints
 * (1100 / 900 / 640, from its mockup) for what CSS alone cannot drop: a tree
 * column, the listing beside an open file. Follows the media query's own
 * change event.
 *
 * `null` while the viewport is not known: in a server render (a static render
 * to HTML) there is no viewport, so no breakpoint can be answered.
 */
export function useViewportAtMost(px: number): boolean | null {
  const query = `(max-width: ${px}px)`;
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    noViewport,
  );
}

function noViewport(): null {
  return null;
}
