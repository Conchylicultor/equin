import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the surrounding region may scroll sideways for content wider than
 * it — the ambient twin of `SingleLine`, for a wide grid table (data-table).
 *
 * A table wider than its box can either squeeze into it or overflow and let
 * its scroller scroll sideways (first column pinned). Overflowing is right only
 * where something scrolls it: a pane's own vertical `Scroll` declares `true`.
 * A drawn box ends the region with `false` — `Surface` (every card, panel and
 * floating card) and `OverlayPanel` (popovers, menus, dialogs) — because a
 * table overflowing a box it sits in spills past its border instead of
 * scrolling. Innermost wins, so a `Scroll` inside a card opens its own region.
 *
 * A context, not a DOM walk alone, because "draws a box" is a fact of the
 * component, not of a computed style; and it crosses portals the right way —
 * a popover's `OverlayPanel` resets it for whatever it portals.
 *
 * Lives in ui-kit (beside `single-line.tsx`) so `OverlayPanel` can reset it
 * without inverting layers.
 */
const SidewaysScrollContext = createContext<boolean>(false);

/** Declares whether content inside may scroll its region sideways. A bare
 *  Provider, like `SingleLineProvider`. */
export function SidewaysScrollProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}) {
  return (
    <SidewaysScrollContext.Provider value={value}>
      {children}
    </SidewaysScrollContext.Provider>
  );
}

/** Reads the ambient sideways-scroll region. `false` outside any provider. */
export function useSidewaysScroll(): boolean {
  return useContext(SidewaysScrollContext);
}
