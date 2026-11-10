import { useEffect, useState } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

/**
 * The CSS var `pr-floating-bar` / `pr-floating-bar-pane` (and the desktop
 * window titlebar) read: the right inset a surface-edge header reserves so the
 * floating bar does not cover its actions. It is set **iff** the floating bar
 * is mounted and in its home slot, so a header falls back to its own end inset
 * whenever the bar is docked, off, or dragged elsewhere.
 */
const SAFE_AREA_VAR = "--floating-bar-safe-area";

/**
 * Which boxes the reservation is set on: exactly the headers that read it. The
 * header that reserves the bar's room is the header the bar sits in — every
 * reserving header names itself the band's anchor (`anchor-floating-bar-band`)
 * — except one inside a `floating-bar-boundary` (a desktop window's content,
 * an app embed), which is not at the viewport's corner whatever its surface
 * believes: {@link BOUNDED_HEADERS} withdraws the reservation from those.
 *
 * Set on those boxes, never on `:root`: a custom property on `<html>` is
 * inherited by every element of the page, so each write restyles the whole
 * document (~300–450 ms on an 18k-element page, measured), where this rule's
 * class-keyed invalidation restyles only the headers it matches (~5 ms).
 */
const RESERVING_HEADERS = ".anchor-floating-bar-band";

/**
 * The reserving headers inside a `floating-bar-boundary`, which take the
 * reservation back (the higher specificity wins over {@link RESERVING_HEADERS}).
 *
 * A plain descendant rule, never `RESERVING_HEADERS:not(.floating-bar-boundary
 * *)`: the boundary class toggles on every surface-mode switch (a desktop
 * window's content gains it, a full-screen tab loses it), and Chrome cannot
 * narrow a class named inside a negated complex selector to the rule's subject
 * — it restyles the boundary's whole subtree, the entire app (~20k elements per
 * switch, measured). A descendant selector is invalidated for its subjects only.
 */
const BOUNDED_HEADERS = `.floating-bar-boundary ${RESERVING_HEADERS}`;

/**
 * Publish the floating bar's safe area while `reserve` holds (the bar sits in
 * its home slot, or is being dragged onto it) and the calling component is
 * mounted. Returns a callback ref for the home slot's band — the fixed box the
 * size of the bar's collapsed footprint, at the bar's home corner.
 *
 * The value lives in a stylesheet of its own, adopted by the document while the
 * bar is mounted: {@link RESERVING_HEADERS} and its {@link BOUNDED_HEADERS}
 * withdrawal, rewritten when the reservation changes and emptied when it is
 * withdrawn.
 *
 * The reservation is measured from the band's LEFT edge to the viewport's right
 * edge (so it includes the bar's corner offset and its panel chrome, and
 * follows the density preset), plus the header's own end inset as the gap
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
  const [sheet] = useState(() => new CSSStyleSheet());

  // Adopted for as long as the bar is mounted; an empty sheet matches nothing.
  useEffect(() => {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (s) => s !== sheet,
      );
    };
  }, [sheet]);

  useResizeObserver(
    () => node,
    () => {
      if (!node || !reserve) return;
      const room = window.innerWidth - node.getBoundingClientRect().left;
      // Returned, the write runs after every other read of the after-layout
      // batch, not between two of them.
      return () =>
        sheet.replaceSync(
          `${RESERVING_HEADERS} { ${SAFE_AREA_VAR}: calc(${Math.ceil(room)}px + var(--chrome-pane-pad-end)); } ` +
            `${BOUNDED_HEADERS} { ${SAFE_AREA_VAR}: initial; }`,
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
    return () => sheet.replaceSync("");
  }, [reserve, sheet]);

  return setNode;
}
