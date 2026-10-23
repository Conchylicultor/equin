/**
 * Scrollers a `useStickyScroll` follows, each with that owner's `arm` — "the
 * next scroll is one the reader asked for".
 */
const owners = new WeakMap<Element, () => void>();

/** `scroller` is followed; `arm` marks its next scroll as the reader's. */
export function listenForNavigation(
  scroller: Element,
  arm: () => void,
): () => void {
  owners.set(scroller, arm);
  return () => {
    if (owners.get(scroller) === arm) owners.delete(scroller);
  };
}

/**
 * Announce that a scroll about to move `target` — or any scroller around it —
 * is a navigation the reader asked for (a jump to a turn, a reveal, a drag at
 * an edge), so a following `useStickyScroll` lets it carry the reader away
 * instead of putting the bottom back. Every sanctioned scroll funnel calls it
 * (`scrollChildIntoView`, `scrollToBottom`/`scrollToTop`, `useEdgeAutoScroll`,
 * scroll-reveal's `revealElement`); a compensation that keeps the reader in
 * place (`KeepAnchorAcross`, `keepInPlace`) must not.
 *
 * Walks `target` and its ancestors — `scrollIntoView` moves every scroller up
 * the chain. Arming a scroller that then does not move changes nothing.
 */
export function announceNavigation(target: Element | null | undefined): void {
  for (let n: Element | null = target ?? null; n; n = n.parentElement)
    owners.get(n)?.();
}
