import { inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { moveBlocks } from "../../core";
import { planBulkMove } from "../../core";
import { BlockSchema, PAGE_BLOCK_TYPE } from "../../core";
import { liveBlocks } from "./live-blocks";
import { blocksChanged } from "./tables-events";
import { loadLiveSiblings } from "./forest";
import { withPageForest } from "./page-forest";
import { pairChanged, parkRanks, updateBlockFields } from "./forest-writer";
import { computePageId, recomputePageIdSubtree } from "./page-id";
import { rowToNode } from "./reconcile";
import { assertNotIntoOwnSubtree } from "./ancestry";

/**
 * The selection twin of `handleMoveBlock`: a dragged selection dropped into
 * ANOTHER page. Locks both forests, runs the same `planBulkMove` the `bulkMove`
 * op runs — but over the destination's COMPLETE live sibling set, which lives
 * outside the source page's forest — then reparents each root and re-scopes its
 * subtree's `page_id`. One transaction, so the selection lands whole or not at
 * all.
 */
export const handleMoveBlocks = implement(moveBlocks, async ({ body }) => {
  const ids = [...new Set(body.ids)];

  // Decides which locks to take, never what to write: everything authoritative
  // is re-read under them. A trashed or unknown id is not addressable (404).
  const sources = await db
    .select({ id: liveBlocks.id, pageId: liveBlocks.pageId })
    .from(liveBlocks)
    .where(inArray(liveBlocks.id, ids));
  if (sources.length !== ids.length) throw new HttpError(404, "Not found");
  const sourcePageIds = new Set(sources.map((s) => s.pageId));
  if (sourcePageIds.size !== 1) {
    throw new HttpError(
      400,
      `Blocks span ${sourcePageIds.size} pages; a moved selection must come from one page`,
    );
  }
  const sourcePageId = sources[0]!.pageId;
  const destPageId = await computePageId(body.parentId);

  const { value } = await withPageForest(
    [sourcePageId, destPageId],
    async (ctx) => {
      const forest = (await ctx.forest())
        .filter((r) => r.pageId === sourcePageId)
        .map(rowToNode);
      if (!ids.every((id) => forest.some((r) => r.id === id))) {
        throw new HttpError(409, "A moved block left its page");
      }
      await assertNotIntoOwnSubtree(ctx.tx, ids, body.parentId);

      // Guards that the destination is LIVE and hands back its complete live
      // sibling set — the rank window `planBulkMove` must mint against.
      const { parent: destParent, siblings } = await loadLiveSiblings(
        ctx.tx,
        body.parentId,
      );
      if (
        body.afterId !== null &&
        !siblings.some((s) => s.id === body.afterId)
      ) {
        throw new HttpError(
          400,
          `Anchor ${body.afterId} is not a child of the destination parent`,
        );
      }
      const plan = planBulkMove(forest, body, siblings.map(rowToNode));
      if (plan.refusal) {
        throw new HttpError(400, `Bulk move refused: ${plan.refusal}`);
      }

      const byId = new Map(forest.map((r) => [r.id, r]));
      await parkRanks(ctx.tx, {
        placements: plan.placements.filter((p) =>
          pairChanged(byId.get(p.id)!, p),
        ),
      });
      for (const p of plan.placements) {
        const row = byId.get(p.id)!;
        // A page arriving under a new parent arrives folded — the same rule
        // `handleMoveBlock` states for one block.
        const arrivesFolded =
          row.type === PAGE_BLOCK_TYPE && row.parentId !== p.parentId;
        await updateBlockFields(ctx.tx, p.id, {
          parentId: p.parentId,
          rank: p.rank,
          ...(arrivesFolded ? { expanded: false } : {}),
        });
        await recomputePageIdSubtree(ctx.tx, p.id);
      }
      // Open a content destination so it shows what landed in it — never a
      // page destination, whose `expanded` embeds that page in ITS parent.
      if (destParent && destParent.type !== PAGE_BLOCK_TYPE) {
        await updateBlockFields(ctx.tx, destParent.id, { expanded: true });
      }

      return ctx.tx
        .select()
        .from(liveBlocks)
        .where(inArray(liveBlocks.id, plan.roots));
    },
  );

  const affected = new Set<string>();
  if (sourcePageId !== null) affected.add(sourcePageId);
  for (const row of value) if (row.pageId !== null) affected.add(row.pageId);
  for (const pageId of affected) await blocksChanged.emit({ pageId });

  return value.map((row) => BlockSchema.parse(row));
});
