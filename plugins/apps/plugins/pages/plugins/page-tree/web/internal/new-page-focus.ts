/**
 * Pages just created by the user, whose title has not taken the caret yet.
 * One-shot: the title that mounts for such a page claims its entry
 * (`claimNewPageFocus`), so reopening the page later never steals focus.
 */
const awaitingTitleFocus = new Set<string>();

/** Ask the page's title to take the caret when it next mounts. */
export function requestNewPageFocus(pageId: string): void {
  awaitingTitleFocus.add(pageId);
}

/** Whether this page's title should take the caret now; consumes the request. */
export function claimNewPageFocus(pageId: string): boolean {
  return awaitingTitleFocus.delete(pageId);
}
