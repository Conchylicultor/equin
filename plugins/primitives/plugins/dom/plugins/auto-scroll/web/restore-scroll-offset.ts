/**
 * Put `scroller` back at an offset read before a commit that may have clamped
 * it: a commit that removes content before inserting what keeps the scroll
 * area open (a stand-in, the replacement) lets anything that forces a layout
 * in between see short content, and the browser clamps — so the reader jumps
 * though the area is back before paint. The imperative twin of
 * `KeepScrollAcross`, for a caller that already reads its offset in its own
 * `getSnapshotBeforeUpdate`. A compensation, not a navigation: it announces
 * nothing. Only the axes passed move.
 */
export function restoreScrollOffset(
  scroller: HTMLElement,
  offset: { top?: number; left?: number },
): void {
  if (offset.top !== undefined && scroller.scrollTop !== offset.top) {
    scroller.scrollTop = offset.top;
  }
  if (offset.left !== undefined && scroller.scrollLeft !== offset.left) {
    scroller.scrollLeft = offset.left;
  }
}
