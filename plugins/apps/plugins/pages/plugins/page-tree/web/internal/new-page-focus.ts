import { useCallback } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { pageDetailPane } from "../panes";

/**
 * Pages just created and opened by the user, whose title has not taken the
 * caret yet. One-shot: the title that mounts for such a page claims its entry
 * (`claimNewPageFocus`), so reopening the page later never steals focus.
 */
const awaitingTitleFocus = new Set<string>();

/**
 * Open a page the user has just created, with the caret in its title — a new
 * page starts by being named, so typing goes straight there without a click.
 * Every create-and-open path (sidebar New page, the Private section's `+`, the
 * welcome templates) opens through this, so none can forget the focus.
 */
export function useOpenNewPage(): (pageId: string) => void {
  const openPane = useOpenPane();
  return useCallback(
    (pageId: string) => {
      awaitingTitleFocus.add(pageId);
      openPane(pageDetailPane, { pageId }, { mode: "push" });
    },
    [openPane],
  );
}

/** Whether this page's title should take the caret now; consumes the request. */
export function claimNewPageFocus(pageId: string): boolean {
  return awaitingTitleFocus.delete(pageId);
}
