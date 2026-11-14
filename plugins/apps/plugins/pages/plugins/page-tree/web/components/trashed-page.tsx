import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Band } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { matchResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { purgeTrash, restoreTrash } from "@plugins/infra/plugins/trash/core";
import {
  PAGES_TRASH_SOURCE,
  trashedPageBlocks,
  type PageData,
  type TrashedPageBlocksRow,
} from "@plugins/page/plugins/editor/core";
import {
  BLOCK_INSET,
  PageContentColumn,
  PageIcon,
} from "@plugins/page/plugins/editor/web";
import {
  buildForest,
  ReadOnlyBlocks,
} from "@plugins/page/plugins/read-only-view/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import "./page-header.css";

const deleteIcon = symbol("delete");
const restoreIcon = symbol("restore-from-trash");

/** The header's space above the icon/title on a page with no cover. */
const HEADER_TOP_STYLE = { paddingTop: "var(--space-2xl)" };
/** The space above the rule closing the header (as the live page's). */
const RULE_STYLE = { paddingTop: "calc(var(--space-xl) + var(--space-xs))" };

export interface TrashedPageViewProps {
  pageId: string;
  /** The page's data as it was when it was trashed. */
  page: PageData;
  /** The ledger entry the page was trashed under — what Restore / Delete name. */
  trashEntryId: string;
  deletedAt: Date;
  /** The centered reading measure the live page's column uses. */
  measureClassName: ClassName;
}

/**
 * A page in the trash, opened (Notion's "This page is in Trash"): a banner
 * saying so, with Restore and Delete permanently, over the page as it was
 * trashed — its icon and title, then its content through the read-only
 * renderer. Nothing here is editable: a trashed page has no live rows to
 * write, and the way back to editing is Restore (after which the pane reads
 * the live page again — the same route, nothing to navigate).
 */
export function TrashedPageView({
  pageId,
  page,
  trashEntryId,
  deletedAt,
  measureClassName,
}: TrashedPageViewProps): ReactElement {
  return (
    <Stack gap="none" className="min-h-full pb-2xl">
      <TrashedPageBanner
        title={page.title}
        trashEntryId={trashEntryId}
        deletedAt={deletedAt}
      />
      <div className={measureClassName}>
        <PageContentColumn>
          <Stack gap="xs" style={HEADER_TOP_STYLE}>
            {page.icon != null && (
              <PageIcon icon={page.icon} className="size-12" />
            )}
            <h1 className="page-doc-title truncate">
              {page.title || "Untitled"}
            </h1>
          </Stack>
          <div style={RULE_STYLE}>
            <Separator />
          </div>
        </PageContentColumn>
      </div>
      <div className={measureClassName}>
        <PageContentColumn>
          <div className="pt-md">
            <TrashedPageContent pageId={pageId} trashEntryId={trashEntryId} />
          </div>
        </PageContentColumn>
      </div>
    </Stack>
  );
}

/** The trashed page's content, as it was trashed, read-only. */
function TrashedPageContent({
  pageId,
  trashEntryId,
}: {
  pageId: string;
  trashEntryId: string;
}): ReactNode {
  const result = useLive(trashedPageBlocks, {
    where: { pageId, trashEntryId },
  });
  return matchResource(result, {
    loading: () => <Loading variant="rows" />,
    ready: (rows) => <TrashedForest pageId={pageId} rows={rows} />,
  });
}

function TrashedForest({
  pageId,
  rows,
}: {
  pageId: string;
  rows: TrashedPageBlocksRow[];
}): ReactElement {
  const forest = useMemo(() => buildForest(rows, pageId), [rows, pageId]);
  if (forest.length === 0) {
    return (
      <Inset x={BLOCK_INSET}>
        <Placeholder tone="muted">This page is empty.</Placeholder>
      </Inset>
    );
  }
  return <ReadOnlyBlocks forest={forest} />;
}

/**
 * The full-width band at the top of a trashed page: what happened and when,
 * and the two ways out — Restore (no confirmation: it is the undo) and Delete
 * permanently (behind a confirmation: the purge is irreversible). Both act on
 * the page's whole trash entry, as the Trash dialog's row actions do.
 */
function TrashedPageBanner({
  title,
  trashEntryId,
  deletedAt,
}: {
  title: string;
  trashEntryId: string;
  deletedAt: Date;
}): ReactElement {
  const restore = useEndpointMutation(restoreTrash);
  const purge = useEndpointMutation(purgeTrash);
  const [confirming, setConfirming] = useState(false);
  const params = { sourceId: PAGES_TRASH_SOURCE, entryId: trashEntryId };

  return (
    <Band
      rule="bottom"
      role="status"
      className="bg-destructive/10 text-destructive border-destructive/20"
    >
      <Cluster gap="md" justify="center">
        <Line className="gap-xs">
          <Icon icon={deleteIcon} />
          <Text className="font-medium">
            This page is in the trash
            <span className="text-muted-foreground font-normal">
              {" · deleted "}
              <RelativeTime date={deletedAt} />
            </span>
          </Text>
        </Line>
        <Line className="gap-xs">
          <Button
            variant="outline"
            loading={restore.isPending}
            onClick={() => restore.mutate({ params })}
          >
            <Icon icon={restoreIcon} />
            Restore page
          </Button>
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => setConfirming(true)}
          >
            Delete permanently
          </Button>
        </Line>
      </Cluster>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent size="sm">
          <DialogTitle>Delete permanently</DialogTitle>
          <Stack gap="lg">
            <DialogDescription>
              Permanently delete{" "}
              <span className="font-medium">{title || "Untitled"}</span>? This
              removes the page and all of its content and cannot be undone.
            </DialogDescription>
            <Stack direction="row" justify="end" gap="sm">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={purge.isPending}
                onClick={() =>
                  purge.mutate(
                    { params },
                    { onSuccess: () => setConfirming(false) },
                  )
                }
              >
                Delete permanently
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>
    </Band>
  );
}
