import { eq } from "drizzle-orm";
import {
  nextRankUnder,
  rankAfterSibling,
} from "@plugins/primitives/plugins/rank/server";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { createBlock } from "../../core";
import { newBlockId } from "../../core";
import { BlockSchema } from "../../core";
import { _blocks } from "./tables";
import { liveBlocks } from "./live-blocks";
import { computePageId } from "./page-id";
import { withPageForest } from "./page-forest";
import { insertBlocks, updateBlockFields } from "./forest-writer";
import { notifyBlockChange } from "./notify";
import { parseBlockData } from "./parse-block-data";
import { BlockLifecycle } from "./document-hooks";

export const handleCreateBlock = implement(
  createBlock,
  async ({ body, req }) => {
    const id = newBlockId();

    // Resolve the destination parent (and through it the forest to lock) before
    // the transaction: an `afterId` insert lands under that sibling's parent. Both
    // reads are liveness guards too — a trashed block is not addressable, so
    // positioning against one is the same 404 an unknown id already gets, and it
    // would otherwise mint a rank against a trashed row's key.
    let parentId = body.parentId ?? null;
    if (body.afterId) {
      const [after] = await db
        .select({ parentId: liveBlocks.parentId })
        .from(liveBlocks)
        .where(eq(liveBlocks.id, body.afterId))
        .limit(1);
      if (!after) throw new HttpError(404, "Block not found");
      parentId = after.parentId;
    }
    const pageId = await computePageId(parentId);

    await withPageForest(pageId, async (ctx) => {
      // The rank is minted under the lock, against the sibling set no concurrent
      // structural write can be permuting.
      const rank = body.afterId
        ? await rankAfterSibling(
            _blocks,
            _blocks.parentId,
            parentId,
            body.afterId,
            _blocks.id,
            ctx.tx,
          )
        : await nextRankUnder(_blocks, _blocks.parentId, parentId, ctx.tx);

      await insertBlocks(ctx.tx, [
        {
          id,
          pageId,
          parentId,
          type: body.type,
          data: parseBlockData(body.type, body.data),
          rank: rank.toJSON(),
        },
      ]);
      if (parentId) {
        await updateBlockFields(ctx.tx, parentId, { expanded: true });
      }
    });

    await notifyBlockChange({ pageId, type: body.type, blockId: id });
    // The row exists and the change has fanned out: contributors may now derive
    // state from it (provenance markers, indexes). Generic dispatch — the handler
    // never names a contributor, and a throwing hook fails the create loudly
    // rather than leaving a half-derived row behind a swallowed error.
    for (const hook of BlockLifecycle.AfterCreate.getContributions()) {
      await hook.afterCreate({ id, type: body.type, parentId, pageId }, req);
    }
    const [row] = await db
      .select()
      .from(liveBlocks)
      .where(eq(liveBlocks.id, id))
      .limit(1);
    if (!row) throw new HttpError(500, "Failed to retrieve created block");
    return BlockSchema.parse(row);
  },
);
