import { useState } from "react";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { VersionHistoryDialog } from "@plugins/history/plugins/dialog/web";
import { pageDetailPane } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { pagesTree } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PageVersionPreview } from "./page-version-preview";

const historyIcon = symbol("history");

/**
 * "Edited 2h ago" in the page-detail title bar (`pageDetailPane.Actions`) —
 * the page's version-history entry point. The label is a quiet fact you read;
 * clicking it opens the reusable VersionHistoryDialog scoped to the pages
 * source, with the diffed page preview injected as `renderPreview`. One
 * affordance, not a label plus a separate History button: "when was this
 * edited" and "what changed" are the same question asked at two depths.
 *
 * The time is the page row's `editedAt` (`pagesTree`) — the newest `updatedAt`
 * across the page row AND its content blocks. The page row's own `updatedAt` is
 * not enough: a content edit stamps only the edited block's own row and never
 * touches the page row, which moves only on a rename, a cover or a kind change.
 * The same field of the same row the sidebar's Recent section and the Welcome
 * page's Recent pages sort by, so the three cannot disagree.
 *
 * Not known yet renders a placeholder, never a time.
 */
export function EditedHistoryAction() {
  const { pageId } = pageDetailPane.useParams();
  const result = useLiveRow(pagesTree, pageId);
  const [open, setOpen] = useState(false);
  switch (result.status) {
    case "loading":
      return <Loading variant="block" className="h-4 w-20" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="icon"
          icon={historyIcon}
          subject="when this page was edited"
          error={result.error}
          refetch={result.refetch}
        />
      );
    case "ready":
      // No such live page (deleted under the pane): no edit time to tell and
      // no history to open; the pane itself renders the missing page.
      if (!result.found) return null;
      return (
        <>
          {/* 8px more air after it than between the bar's actions: the time
              is a statement about the page, set apart from the controls after
              it. Ghost + faint at rest, so it still reads as a label first. */}
          <ControlSizeProvider size="xs">
            <Button
              tooltip="Version history"
              variant="ghost"
              className="text-caption font-normal text-faint-foreground"
              style={{ marginRight: "var(--space-sm)" }}
              onClick={() => setOpen(true)}
            >
              Edited <RelativeTime date={result.row.editedAt} />
            </Button>
          </ControlSizeProvider>
          {open && (
            <VersionHistoryDialog
              open={open}
              onOpenChange={setOpen}
              sourceId="pages"
              entityId={pageId}
              renderPreview={(version) => (
                <PageVersionPreview pageId={pageId} versionId={version.id} />
              )}
            />
          )}
        </>
      );
  }
}
