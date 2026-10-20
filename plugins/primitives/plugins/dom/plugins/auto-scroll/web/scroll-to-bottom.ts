export interface ScrollToBottomOptions {
  behavior?: ScrollBehavior;
}

/** Imperative sanctioned funnel: scroll a container to its bottom edge. The
 * bottom-pin analog of scroll-reveal's revealElement — for callers that hold an
 * element but not a mounted useStickyScroll handle. */
export function scrollToBottom(
  el: HTMLElement | null | undefined,
  opts?: ScrollToBottomOptions,
): void {
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: opts?.behavior ?? "auto" });
}

/** Imperative sanctioned funnel: scroll a container to its top edge — where a
 * list that loads older content on reaching the top (a long transcript) loads
 * it. The top-edge twin of {@link scrollToBottom}. */
export function scrollToTop(
  el: HTMLElement | null | undefined,
  opts?: ScrollToBottomOptions,
): void {
  if (!el) return;
  el.scrollTo({ top: 0, behavior: opts?.behavior ?? "auto" });
}
