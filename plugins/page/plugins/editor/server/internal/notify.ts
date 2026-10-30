import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PAGE_BLOCK_TYPE } from "../../core";
import { blocksChanged } from "./tables-events";

// Announce a change to a single block. Emits `blocksChanged` so subscribers
// (links / image reindexers) refresh that page. The `page_blocks` content +
// sidebar live resources are invalidated automatically by the L4 DB change-feed
// on the underlying write, so this helper only fans out the cross-plugin event.
// Pass the block's `type` so the caller doesn't re-query.
//
// `executor` rides the emit, as in `notifyStructuralChange`: a caller driving a
// db-test-fixture DB emits against ITS trigger table (subscriber-less there — a
// no-op); production passes nothing and the event dispatches on the global
// handle.
export async function notifyBlockChange(
  args: {
    pageId: string | null;
    type: string;
    blockId?: string;
  },
  executor?: NodePgDatabase,
): Promise<void> {
  const opts = executor ? { tx: executor } : undefined;
  if (args.type === PAGE_BLOCK_TYPE) {
    // A page block's own attachments (its cover) are scoped to the page block
    // itself, not its `page_id` (which points at the parent, and is null for
    // root pages). Emit for its own id so the attachment reconcile links the
    // cover.
    if (args.blockId != null)
      await blocksChanged.emit({ pageId: args.blockId }, opts);
  }
  if (args.pageId !== null) {
    await blocksChanged.emit({ pageId: args.pageId }, opts);
  }
}
