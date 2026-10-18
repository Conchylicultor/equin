import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { BlockSchema, PAGE_BLOCK_TYPE, type Block } from "../../core/schemas";
import type { BlockData } from "@plugins/page/plugins/block-entity/core";
import { liveBlocks } from "./live-blocks";
import { withPageForest, type ForestExecutor } from "./page-forest";
import { updateBlockFields } from "./forest-writer";
import { notifyBlockChange } from "./notify";
import type { BlockDataRewrite } from "./parse-block-data";

/** The page row as it is stored now, read under the page's lock. */
export interface LockedPageRow {
  type: string;
  data: BlockData;
}

/**
 * Rewrite one PAGE row's `data`, with the read that decides the write taken
 * under the lock of the forest the row lives in — the shared body of the two
 * page-level writes that are not the header's own `PATCH`: the kind control
 * (`setPageKind`), an agent's rename (`renamePage`) and the icon
 * (`setPageIcon`).
 *
 * The shape is `handle-update-block.ts`'s, for its reasons:
 *
 * - **The scope is read before the lock, and everything else after.** A page
 *   row's `page_id` is the page it is DISPLAYED in (its parent's; `null` for a
 *   top-level page), so that is the forest to lock — the same one the header's
 *   title edit locks. The unlocked read names the lock and nothing more.
 * - **`decide` sees the row as it is under the lock.** A concurrent delete is
 *   the same 404 an unknown id gets (a trashed row is not addressable), and a
 *   judgement about the row — "is this still an agent page?" — is made against
 *   the one no concurrent write can change before this one commits. A check
 *   made before the lock would leave exactly that race.
 * - **`decide` returns the new data, or `null` for "nothing to write".** A
 *   no-op writes nothing and announces nothing, so setting what is already set
 *   costs no event and no push. It may also throw, which rolls back and writes
 *   nothing.
 * - **The announcement runs after commit.** `notifyBlockChange` emits for the
 *   page's own id and for the page it sits in — which is what refreshes the
 *   parent's row and the sidebar.
 *
 * Only a page: any other row is a 400, before the lock and again under it (a
 * conversion can race the first read).
 */
export async function rewritePageRow(
  pageId: string,
  decide: (row: LockedPageRow) => BlockDataRewrite | null,
  executor: ForestExecutor = db,
): Promise<Block> {
  const [existing] = await executor
    .select({ type: liveBlocks.type, pageId: liveBlocks.pageId })
    .from(liveBlocks)
    .where(eq(liveBlocks.id, pageId))
    .limit(1);
  if (!existing) throw new HttpError(404, "Page not found");
  if (existing.type !== PAGE_BLOCK_TYPE) {
    throw new HttpError(400, `Block ${pageId} is not a page`);
  }

  const { value: written } = await withPageForest(
    existing.pageId,
    async (ctx) => {
      const [row] = await ctx.tx
        .select({
          type: liveBlocks.type,
          data: liveBlocks.data,
          pageId: liveBlocks.pageId,
        })
        .from(liveBlocks)
        .where(eq(liveBlocks.id, pageId))
        .limit(1);
      if (!row) throw new HttpError(404, "Page not found");
      if (row.type !== PAGE_BLOCK_TYPE) {
        throw new HttpError(400, `Block ${pageId} is not a page`);
      }

      const data = decide(row);
      if (data === null) return null;
      await updateBlockFields(ctx.tx, pageId, { data });
      return { pageId: row.pageId };
    },
    executor,
  );

  if (written !== null) {
    await notifyBlockChange(
      { pageId: written.pageId, type: PAGE_BLOCK_TYPE, blockId: pageId },
      executor,
    );
  }

  const [row] = await executor
    .select()
    .from(liveBlocks)
    .where(eq(liveBlocks.id, pageId))
    .limit(1);
  if (!row) throw new HttpError(404, "Page not found after update");
  return BlockSchema.parse(row);
}
