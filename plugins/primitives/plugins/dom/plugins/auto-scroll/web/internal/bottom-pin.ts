/**
 * Scrollers whose position a FOLLOWING `useStickyScroll` owns, each with that
 * owner's own write to the bottom.
 *
 * While a surface follows, what the reader is anchored to is the bottom, not a
 * row — so every other anchoring in this plugin must stand down on that
 * scroller, exactly as browser scroll anchoring does (`overflow-anchor: none`,
 * set by the same toggle). `KeepAnchorAcross` keeping a row in place across a
 * commit that also appends a row (a paged transcript's window sliding: its
 * oldest row released above as the new one lands below) scrolled the follower
 * up by the released row's height — a scroll the follower did not write,
 * ending short of the end, read as the reader leaving: the surface parked and
 * new rows arrived off screen.
 *
 * The pin is the owner's write, not a bare `scrollTop`: the owner records it as
 * its own, so re-pinning can never be read as a foreign scroll.
 */
const pins = new WeakMap<Element, () => void>();

/** `scroller` follows its bottom; `repin` writes it there as the owner. */
export function claimBottomPin(scroller: Element, repin: () => void): void {
  pins.set(scroller, repin);
}

export function releaseBottomPin(scroller: Element): void {
  pins.delete(scroller);
}

/** The owner's write to the bottom, while `scroller` follows it. */
export function bottomPinOf(scroller: Element): (() => void) | undefined {
  return pins.get(scroller);
}
