import { useEffect, useState } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

/**
 * The CSS var `pr-floating-bar` / `pr-floating-bar-pane` read: the right inset
 * a surface-edge header reserves so the floating bar does not cover its
 * actions. It exists on `:root` **iff** the floating bar is mounted and in its
 * home slot, so a header falls back to its own end inset whenever the bar is
 * docked, off, or dragged elsewhere.
 */
const SAFE_AREA_VAR = "--floating-bar-safe-area";

/**
 * Publish the floating bar's safe area while `reserve` holds (the bar sits in
 * its home slot, or is being dragged onto it) and the calling component is
 * mounted. Returns a callback ref for the home slot's band — the fixed box the
 * size of the bar's collapsed footprint, at the bar's home corner.
 *
 * The reservation is measured from the band's LEFT edge to the viewport's right
 * edge (so it includes the bar's corner offset and its panel chrome, and
 * follows the density preset), plus the pane header's own end inset as the gap
 * between the header's last action and the bar. It is the COLLAPSED footprint
 * only: the bar expands leftward on hover as a card over the header, while the
 * hitbox the band wraps holds its collapsed size. Never measure the trigger: it
 * rides the open panel to its left end, so a trigger resize while open (the
 * health dot growing a count) would publish the expanded width and keep it
 * after closing, pushing the header's actions away from the collapsed bar.
 * The band is `fixed right-*`, so a window resize moves its left edge with the
 * viewport's right one and the distance holds — only a resize of the band
 * itself (the footprint re-derived on close) needs a re-measure.
 */
export function useFloatingBarSafeArea(
  reserve: boolean,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);

  useResizeObserver(
    () => node,
    () => {
      if (!node || !reserve) return;
      const room = window.innerWidth - node.getBoundingClientRect().left;
      document.documentElement.style.setProperty(
        SAFE_AREA_VAR,
        `calc(${Math.ceil(room)}px + var(--chrome-pane-pad-end))`,
      );
    },
    // Undebounced: a resize observation is delivered before paint, so the
    // header never paints a frame with a stale reservation (the slot sizing
    // itself to the bar on mount would otherwise glide in from 0).
    { deps: [node, reserve], debounce: false },
  );

  // Withdraw the reservation when the bar leaves its slot (dragged off it) or
  // goes away (docked mode, config off, embed). The headers' `pr-floating-bar*`
  // transition their padding, so their actions glide into the freed room.
  useEffect(() => {
    if (!reserve) return;
    return () => {
      document.documentElement.style.removeProperty(SAFE_AREA_VAR);
    };
  }, [reserve]);

  return setNode;
}
