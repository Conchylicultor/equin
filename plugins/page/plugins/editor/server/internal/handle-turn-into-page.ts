import { asc, eq } from "drizzle-orm";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { turnIntoPage, type TurnIntoPageBody } from "../../core/endpoints";
import { newBlockId } from "../../core/block-id";
import { applyBlockOp, textOf } from "../../core/block-ops";
import { hasTextKey } from "../../core/row-data";
import {
  BlockSchema,
  PAGE_BLOCK_TYPE,
  withPageKind,
  type Block,
} from "../../core/schemas";
import { liveBlocks } from "./live-blocks";
import { recomputePageIdSubtree } from "./page-id";
import {
  withPageForest,
  type ForestExecutor,
  type PageForestCtx,
} from "./page-forest";
import {
  insertBlocks,
  updateBlockFields,
  writeForestTarget,
} from "./forest-writer";
import { rowToNode } from "./reconcile";
import { blockOpCtx } from "./handle-apply-block-op";
import { notifyBlockChange } from "./notify";
import { parseBlockData, rewriteBlockData } from "./parse-block-data";

/**
 * "Turn into → Page": convert an existing content block into a sub-page **in
 * place**. The block keeps its id, its position in the sibling ordering, and its
 * children — it just becomes the `page` row, which the content editor renders as
 * an inline sub-page link. Its title is either a literal (its former text, for
 * an ordinary block) or its FIRST CHILD's text, which that child gives up —
 * see {@link consumeFirstChild}.
 *
 * This is the ONLY sanctioned in-place transition into `PAGE_BLOCK_TYPE`.
 * `handlePatchBlocks` rejects any `type` transition into or out of `page` with a
 * 409, because a blind row-level writer cannot maintain the `page_id` partition:
 * a `page` row owns every row keyed `page_id = <its id>`, and flipping the type
 * without re-scoping the descendants either orphans that content forever or
 * leaves the new page's children pointing at the outer page. Here the
 * `recomputePageIdSubtree` call inside the same transaction re-scopes them,
 * which is exactly what makes the transition representable. The two handlers are
 * distinct, so this path is naturally exempt from that guard.
 *
 * A page with no children renders nothing typeable (the first content block can
 * only be created by splitting an existing one), so a block left childless is
 * seeded with one empty content block — same reason as `createPageWithSeed`. The
 * seed's `type` and `data` come from the REQUEST, not from this plugin: the
 * editor must not import a concrete block type (`@plugins/page/plugins/text`),
 * which would form an editor↔text cycle. That is the same seam
 * `CreateBlockBodySchema.type` already uses.
 *
 * Parameterized on the executor so a db-test-fixture suite drives exactly what
 * production runs (the mirror of `applyPageBlockOp`).
 */
export async function turnBlockIntoPage(
  blockId: string,
  body: TurnIntoPageBody,
  executor: ForestExecutor = db,
): Promise<Block> {
  // A trashed block is not addressable (404, like an unknown id).
  const [block] = await executor
    .select({ pageId: liveBlocks.pageId, type: liveBlocks.type })
    .from(liveBlocks)
    .where(eq(liveBlocks.id, blockId))
    .limit(1);
  if (!block) throw new HttpError(404, "Block not found");
  if (block.type === PAGE_BLOCK_TYPE) {
    throw new HttpError(409, `Block ${blockId} is already a page`);
  }

  // Two forests change: the containing page's (one of its rows becomes a page
  // shell) and the block's own, which comes into existence here — every
  // descendant moves into the `page_id = blockId` partition.
  await withPageForest(
    [block.pageId, blockId],
    async (ctx) => {
      // Re-read under the lock: the row's CURRENT type and data are what this
      // write replaces, and a concurrent conversion or delete between the scope
      // read above and here must not be written over.
      const [current] = await ctx.tx
        .select({ type: liveBlocks.type, data: liveBlocks.data })
        .from(liveBlocks)
        .where(eq(liveBlocks.id, blockId))
        .limit(1);
      if (!current) throw new HttpError(404, "Block not found");
      if (current.type === PAGE_BLOCK_TYPE) {
        throw new HttpError(409, `Block ${blockId} is already a page`);
      }

      // The child that gives up its line for the title, read under the lock
      // (a concurrent insert ahead of it cannot slip in between).
      const titleChild =
        typeof body.title === "string"
          ? null
          : await firstTextChild(ctx, blockId);
      const title =
        typeof body.title === "string"
          ? body.title
          : titleChild === null
            ? ""
            : textOf(titleChild).trim();

      await updateBlockFields(ctx.tx, blockId, {
        type: PAGE_BLOCK_TYPE,
        // A TYPE change, so `rewriteBlockData` validates and judges no author:
        // this is where a page is born, and the one place its KIND is chosen
        // at birth — `agent-page` is the `/agent-page` insert (a page a human
        // made for an agent to fill) and the agent card's Turn into → Agent
        // page, `instructions` the `/instructions page` insert. Absent is a
        // human's page, as ever.
        data: rewriteBlockData({
          type: PAGE_BLOCK_TYPE,
          before: current,
          next: withPageKind(
            { title, icon: null },
            body.kind ?? { kind: "page" },
          ),
        }),
        // Turn into → Page folds deterministically, rather than inheriting
        // whatever the block had (e.g. an expanded toggle). A sub-page reads as
        // ONE row in its parent's flow — the point of promoting content into a
        // page is that the parent stops showing it — and the `collapsible:
        // "always"` chevron on the page row is the way back in.
        expanded: false,
      });

      // The block just became a page, so every descendant's nearest `page`
      // ancestor changed: they move from the outer page's `page_id` partition
      // into this block's. Without this the children stay addressed to the
      // outer page and render as its content — the orphaning the patch guard
      // exists to prevent.
      await recomputePageIdSubtree(ctx.tx, blockId);

      if (titleChild !== null)
        await consumeFirstChild(ctx, blockId, titleChild);

      // Seeding is conditional on the page being childless — after the title
      // child left, so a card holding one line becomes a page with one empty
      // line rather than none. A concurrent insert cannot leave both a new
      // child and a stray seed: no structural write to either forest can
      // interleave under the page lock.
      const children = await ctx.tx
        .select({ id: liveBlocks.id })
        .from(liveBlocks)
        .where(eq(liveBlocks.parentId, blockId));

      if (children.length === 0) {
        await insertBlocks(ctx.tx, [
          {
            id: newBlockId(),
            // The new page is its own `page_id` scope; its content hangs off it.
            pageId: blockId,
            parentId: blockId,
            type: body.seedChild.type,
            data: parseBlockData(body.seedChild.type, body.seedChild.data),
            rank: Rank.between(null, null).toJSON(),
          },
        ]);
      }
    },
    executor,
  );

  const [row] = await executor
    .select()
    .from(liveBlocks)
    .where(eq(liveBlocks.id, blockId))
    .limit(1);
  if (!row) throw new HttpError(500, "Block vanished during turn-into-page");

  // Emits for the new page's own id (its content list just appeared, and lost
  // its title line) AND for the containing page, whose content list lost the
  // block's subtree.
  await notifyBlockChange(
    {
      pageId: row.pageId,
      type: PAGE_BLOCK_TYPE,
      blockId: row.id,
    },
    executor,
  );

  return BlockSchema.parse(row);
}

/**
 * The block's first child by rank, when it can give a title: a line holding
 * text. A sub-page row (its content lives in its own partition), a nested
 * container (its content IS its children) or a void block has no line to give,
 * so it stays where it is and the page is untitled — consuming it would drop
 * content for a title it does not hold.
 */
async function firstTextChild(
  ctx: PageForestCtx,
  blockId: string,
): Promise<{ id: string; data: unknown } | null> {
  const [first] = await ctx.tx
    .select({ id: liveBlocks.id, type: liveBlocks.type, data: liveBlocks.data })
    .from(liveBlocks)
    .where(eq(liveBlocks.parentId, blockId))
    .orderBy(asc(liveBlocks.rank))
    .limit(1);
  if (!first) return null;
  if (first.type === PAGE_BLOCK_TYPE || !hasTextKey(first.data)) return null;
  return { id: first.id, data: first.data };
}

/**
 * Remove the title child from the new page, its own children taking its slot —
 * the reducer's `unwrap` (the same op that dissolves a container: the row goes,
 * its children are promoted into the slot it held, before its next sibling,
 * order preserved), written through `writeForestTarget` like any op. So the
 * removal is a TRASH under one `page-blocks` ledger entry (its content doc,
 * ext rows and history survive; `OnTrash` runs after commit), the promoted rows
 * are rank-parked and re-placed, and the doc-rank reconcile sees every write.
 *
 * Runs after `recomputePageIdSubtree`, so the forest it reads is the new page's
 * own partition — the one `unwrap`'s placement stays inside.
 */
async function consumeFirstChild(
  ctx: PageForestCtx,
  pageId: string,
  child: { id: string },
): Promise<void> {
  const before = (await ctx.forest())
    .filter((r) => r.pageId === pageId)
    .map(rowToNode);
  const after = applyBlockOp(
    before,
    { kind: "unwrap", blockId: child.id },
    blockOpCtx(),
  );
  const write = await writeForestTarget(ctx, before, after);
  // The title child is never a page row (`firstTextChild`), and `unwrap`
  // removes nothing but it, so nothing here is deferred to the page-delete
  // chokepoint. A deferred set would leave the row live: fail loudly.
  if (write.deferredToChokepoint) {
    throw new Error(
      `turn-into-page: consuming title child ${child.id} reached a page row`,
    );
  }
}

export const handleTurnIntoPage = implement(turnIntoPage, ({ params, body }) =>
  turnBlockIntoPage(params.id, body),
);
