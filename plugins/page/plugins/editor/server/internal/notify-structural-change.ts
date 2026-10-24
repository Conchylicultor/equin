import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PAGE_BLOCK_TYPE } from "../../core/schemas";
import type { PageScope } from "./page-forest";
import { blocksChanged } from "./tables-events";

/**
 * Shared post-commit event fan-out for a structural edit to a page's content
 * (the `applyBlockOp` and `patch` handlers both call this). It:
 *
 *   1. emits `blocksChanged` for the edited page so the link/image reindexers
 *      refresh — none for the workspace root (`pageId: null`), which is no
 *      page's content: its rows are pages, announced by 3 when created;
 *   2. for any `type="page"` block in the deleted set, emits its `blocksChanged`;
 *      and
 *   3. for any `type="page"` block the edit CREATED, emits its `blocksChanged` —
 *      the mirror of 2. A new page's content arrived under a `page_id` nothing
 *      has announced, and every consumer of that page's content (search, history,
 *      links, attachments) keys on this event. A markdown apply minting an
 *      `<agent-page>`, and a paste or duplicate of a sub-page, all create one.
 *
 * The `page_blocks` content + sidebar live resources are invalidated
 * automatically by the L4 DB change-feed on the underlying write, so this helper
 * only fans out the cross-plugin event. Factored out of the per-handler bodies
 * so the two structural endpoints share one trigger path.
 */
export async function notifyStructuralChange(
  args: {
    pageId: PageScope;
    /**
     * Rows removed from the page's live content by this edit (hard-deleted OR
     * trashed), to fan out one `blocksChanged` per emptied sub-page. Only `id` and
     * `type` are read.
     */
    deletedRows: { id: string; type: string }[];
    /** Page rows this edit inserted (`ForestWriteResult.createdPageIds`). */
    createdPageIds: readonly string[];
  },
  executor?: NodePgDatabase,
): Promise<void> {
  // `executor` rides the emit so a caller driving a db-test-fixture DB emits
  // against ITS trigger table (subscriber-less there — a no-op); production
  // passes nothing and the event dispatches on the global handle.
  const opts = executor ? { tx: executor } : undefined;
  // Deliberately NOT `notifyBlockChange`: its extra page-block branch needs a
  // `blockId` (a page block's cover attachments are scoped to the page block's
  // own id, not its `page_id`), and a structural edit has no single block to
  // name. If that emit is ever wanted here, pass a `blockId` — do not go back to
  // deriving a `type` from the edited blocks, which selected the branch without
  // supplying what it needs and so did nothing at all.
  if (args.pageId !== null)
    await blocksChanged.emit({ pageId: args.pageId }, opts);

  const deletedPages = args.deletedRows.filter(
    (r) => r.type === PAGE_BLOCK_TYPE,
  );
  for (const p of deletedPages) {
    await blocksChanged.emit({ pageId: p.id }, opts);
  }
  for (const id of args.createdPageIds) {
    await blocksChanged.emit({ pageId: id }, opts);
  }
}
