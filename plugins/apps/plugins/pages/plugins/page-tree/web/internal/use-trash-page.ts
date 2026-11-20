import { useLive } from "@plugins/network/plugins/live/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  useOpenPane,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { useUndoRedo } from "@plugins/primitives/plugins/undo-redo/web";
import { useUndoableTrash } from "@plugins/infra/plugins/trash/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { pagesTree, deleteBlock } from "@plugins/page/plugins/editor/core";
import { pageDetailPane } from "../panes";

/**
 * Move a page to the trash — instant, silent, and reversible (Notion's model).
 * There is no confirm dialog because the delete is NOT destructive: the server
 * chokepoint TRASHES any subtree containing a page (soft delete — content,
 * sub-pages, CRDT docs, and version history all survive), so the honest
 * affordance is an Undo, not a "cannot be undone" warning. The page's block
 * leaves its parent; links to it elsewhere stay, drawn as a trashed reference.
 *
 * The undo entry is recorded by the `infra/trash` seam onto the TAB's history,
 * so Cmd+Z restores the page from anywhere in the tab — and the toast's Undo
 * button is just that same `undo()`.
 *
 * The one trash path of every surface that offers it (the sidebar row action,
 * the page menu), so they cannot drift on what happens to the open pane.
 */
export function useTrashPage(): (page: {
  id: string;
  title: string;
}) => Promise<void> {
  const fetchEndpoint = useFetchEndpoint();
  const trashWithUndo = useUndoableTrash();
  const { undo } = useUndoRedo();
  const toast = useToast();
  const openPane = useOpenPane();
  const paneStore = usePaneStore();
  const openPageId = pageDetailPane.useRouteEntry()?.params.pageId;
  // The open page with its chain up (its PAGE ancestors): one row read with
  // its ancestors — every caller asks the same tuple.
  const openPage = useLive(pagesTree, {
    id: openPageId ?? null,
    include: "ancestors",
  });

  return async ({ id: pageId, title }) => {
    // Trashing the page the detail pane is showing (or one of its page
    // ancestors) would leave the pane rendering a page that is no longer in
    // the tree — so fall back to the Pages landing surface (the empty route
    // re-resolves to the app's index pane). The `onUndo` hook re-opens it, so
    // Cmd+Z puts the user back exactly where they were. With the open page's
    // chain unknown (loading or failed) the ancestry cannot be told, so the
    // pane is left as it is — except for the open page itself, which needs no
    // chain to recognise.
    const reopenId =
      openPageId !== undefined &&
      (pageId === openPageId ||
        (openPage.status === "ready" &&
          openPage.found &&
          openPage.ancestors.some((page) => page.id === pageId)))
        ? openPageId
        : undefined;

    await trashWithUndo({
      label: `Delete ${title || "Untitled"}`,
      trash: () => fetchEndpoint(deleteBlock, { id: pageId }),
      onUndo:
        reopenId === undefined
          ? undefined
          : () =>
              openPane(pageDetailPane, { pageId: reopenId }, { mode: "push" }),
    });

    if (reopenId !== undefined) paneStore.clearRoute();

    toast({
      type: "pages-page-trashed",
      title: "Page moved to trash",
      description: "",
      category: "confirmations",
      liveAction: { label: "Undo", onClick: () => undo() },
    });
  };
}
