import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { TrashOutcome } from "@plugins/infra/plugins/trash/core";
import { deleteBlock } from "../../core";
import { liveBlocks } from "./live-blocks";
import { blocksChanged } from "./tables-events";
import { deleteBlocksSubtree } from "./trash-blocks";

// The explicit `Promise<TrashOutcome>` return annotation is load-bearing: without
// it TS widens the two literal branches into `{ trashed: boolean; sourceId?: … }`,
// which no longer matches the endpoint's discriminated response schema.
export const handleDeleteBlock = implement(
  deleteBlock,
  async ({ params }): Promise<TrashOutcome> => {
    // A trashed block is not addressable — it appears in no resource, so no
    // client can legitimately name one — hence the same 404 an unknown id gets.
    const [target] = await db
      .select({
        id: liveBlocks.id,
        pageId: liveBlocks.pageId,
        type: liveBlocks.type,
      })
      .from(liveBlocks)
      .where(eq(liveBlocks.id, params.id))
      .limit(1);
    if (!target) throw new HttpError(404, "Not found");

    // The delete chokepoint: EVERY delete is a trash (soft delete — the FK
    // cascade never fires, so descendants + page_block_docs + history survive).
    // A page root mints a `pages` entry; a page-free subtree a `page-blocks` one.
    // It runs the OnTrash lifecycle hooks.
    const outcome = await deleteBlocksSubtree([params.id]);

    // The trashed block's content list lost a row. Fan out to reindex
    // subscribers for its containing page; the page_blocks live resources
    // invalidate via the L4 DB change-feed on the underlying write.
    if (target.pageId !== null) {
      await blocksChanged.emit({ pageId: target.pageId });
    }

    if (!outcome.trashed) return { trashed: false };

    // ONE root ⇒ exactly one entry: a page root mints its own entry, and any
    // leftover rows fold into that first entry (see `deleteBlocksSubtree`). The
    // caller gets that ledger handle — WITH its source — so it can offer an Undo
    // (restore) against the right `/api/trash/:sourceId/…`.
    const entry = outcome.entries[0];
    if (entry === undefined) {
      throw new HttpError(500, "Trashed subtree produced no trash entry");
    }
    return { trashed: true, sourceId: entry.sourceId, entryId: entry.entryId };
  },
);
