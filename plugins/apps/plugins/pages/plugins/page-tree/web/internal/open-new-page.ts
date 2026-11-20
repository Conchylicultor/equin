import { useCallback } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { pageDetailPane } from "../panes";
import { requestNewPageFocus } from "./new-page-focus";

/**
 * Open a page the user has just created BESIDE the current column, with the
 * caret in its title — a new page starts by being named, so typing goes
 * straight there without a click. The Pages app's create-and-open paths
 * (sidebar New page, the Private section's `+`, the welcome templates) open
 * through this; a page made from inside the editor (`/page`) opens through the
 * page navigation's `openNew`, which requests the same focus.
 */
export function useOpenNewPage(): (pageId: string) => void {
  const openPane = useOpenPane();
  return useCallback(
    (pageId: string) => {
      requestNewPageFocus(pageId);
      openPane(pageDetailPane, { pageId }, { mode: "push" });
    },
    [openPane],
  );
}
