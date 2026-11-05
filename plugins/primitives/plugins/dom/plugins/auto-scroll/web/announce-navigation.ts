/**
 * Scrollers someone keeps a position on (a `useStickyScroll` following, a
 * `useScrollAcrossReload` restoring), each with its owners' `arm` — "the next
 * scroll is one the reader asked for".
 */
const owners = new WeakMap<Element, Set<() => void>>();

/** `scroller` is kept; `arm` marks its next scroll as the reader's. */
export function listenForNavigation(
  scroller: Element,
  arm: () => void,
): () => void {
  let arms = owners.get(scroller);
  if (!arms) {
    arms = new Set();
    owners.set(scroller, arms);
  }
  arms.add(arm);
  return () => {
    const current = owners.get(scroller);
    if (!current) return;
    current.delete(arm);
    if (current.size === 0) owners.delete(scroller);
  };
}

/**
 * Announce that a scroll about to move `target` — or any scroller around it —
 * is a navigation the reader asked for (a jump to a turn, a reveal, a drag at
 * an edge), so a following `useStickyScroll` lets it carry the reader away
 * instead of putting the bottom back, and a pending `useScrollAcrossReload`
 * stops restoring. Every sanctioned scroll funnel calls it
 * (`scrollChildIntoView`, `scrollToBottom`/`scrollToTop`, `useEdgeAutoScroll`,
 * scroll-reveal's `revealElement`); a compensation that keeps the reader in
 * place (`KeepAnchorAcross`, `keepInPlace`) must not.
 *
 * Walks `target` and its ancestors — `scrollIntoView` moves every scroller up
 * the chain. Arming a scroller that then does not move changes nothing.
 */
export function announceNavigation(target: Element | null | undefined): void {
  for (let n: Element | null = target ?? null; n; n = n.parentElement) {
    const arms = owners.get(n);
    if (arms) for (const arm of arms) arm();
  }
}
