/** The row the reader is looking at: its anchor name and its top on screen. */
export interface ViewAnchor {
  el: Element;
  /** The row's `anchorAttr` value — content identity, stable across re-creation. */
  name: string;
  /** Its top edge, in viewport coordinates. */
  top: number;
}

/**
 * The first element under `container` marked with `anchorAttr` whose bottom is
 * below `viewTop` — what the reader is looking at. Shared by every anchoring in
 * this plugin (`KeepAnchorAcross`, `useStickyScroll`'s saved position), so they
 * cannot disagree on which row that is.
 *
 * Candidates inside a `weakAttr` element are a last resort, taken only when no
 * other is on screen: content pinned with `position: sticky` is always "on
 * screen" while its section is, so taking it would name the section's start
 * (thousands of px above the reader) instead of the row being read; a
 * placeholder about to be replaced is a poor anchor for the same reason.
 */
export function findViewAnchor(
  container: ParentNode,
  viewTop: number,
  anchorAttr: string,
  weakAttr?: string,
): ViewAnchor | null {
  let weak: ViewAnchor | null = null;
  for (const el of container.querySelectorAll(`[${anchorAttr}]`)) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= viewTop) continue;
    const anchor = { el, name: el.getAttribute(anchorAttr)!, top: rect.top };
    if (weakAttr === undefined || el.closest(`[${weakAttr}]`) === null) {
      return anchor;
    }
    weak ??= anchor;
  }
  return weak;
}
