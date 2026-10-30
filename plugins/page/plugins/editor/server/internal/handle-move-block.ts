import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { rankAdjacentTo } from "@plugins/primitives/plugins/rank/server";
import { moveBlock } from "../../core";
import { BlockSchema, PAGE_BLOCK_TYPE } from "../../core";
import { liveBlocks } from "./live-blocks";
import { blocksChanged } from "./tables-events";
import { loadLiveSiblings } from "./forest";
import { withPageForest } from "./page-forest";
import { updateBlockFields } from "./forest-writer";
import { computePageId, recomputePageIdSubtree } from "./page-id";
import { assertNotIntoOwnSubtree } from "./ancestry";

export const handleMoveBlock = implement(
  moveBlock,
  async ({ params, body }) => {
    if (body.parentId === params.id) {
      throw new HttpError(400, "Cannot parent a block to itself");
    }
    if (body.targetId === params.id) {
      throw new HttpError(400, "Cannot position a block relative to itself");
    }

    // Name the two forests this move permutes — the block's own page and the
    // destination's — so BOTH are locked and a cross-page move is atomic against
    // each page's op stream. Read outside the lock deliberately: it decides which
    // locks to take, never what to write, and everything authoritative is re-read
    // under them. (`computePageId` is also the destination's liveness guard, so a
    // trashed or missing parent still 404s — and so does a trashed SOURCE: a
    // trashed block is not addressable.)
    const [source] = await db
      .select({ pageId: liveBlocks.pageId })
      .from(liveBlocks)
      .where(eq(liveBlocks.id, params.id))
      .limit(1);
    if (!source) throw new HttpError(404, "Not found");
    const destPageId = await computePageId(body.parentId);

    // The page lock subsumes the bespoke read-the-siblings-inside-the-tx defence
    // this handler used to hand-roll: every read here is already under it.
    const { value } = await withPageForest(
      [source.pageId, destPageId],
      async (ctx) => {
        const [before] = await ctx.tx
          .select({
            id: liveBlocks.id,
            pageId: liveBlocks.pageId,
            parentId: liveBlocks.parentId,
            type: liveBlocks.type,
          })
          .from(liveBlocks)
          .where(eq(liveBlocks.id, params.id))
          .limit(1);
        if (!before) throw new HttpError(404, "Not found");
        await assertNotIntoOwnSubtree(ctx.tx, [params.id], body.parentId);

        // Guards that the destination parent is LIVE (404 otherwise) and returns it
        // alongside its complete live sibling set — see `loadLiveSiblings`.
        const { parent: destParent, siblings } = await loadLiveSiblings(
          ctx.tx,
          body.parentId,
        );
        if (
          body.targetId !== null &&
          !siblings.some((s) => s.id === body.targetId)
        ) {
          throw new HttpError(
            400,
            `Target ${body.targetId} is not a child of the destination parent`,
          );
        }
        const rank = rankAdjacentTo(
          siblings,
          body.parentId,
          body.targetId,
          body.zone,
          new Set([params.id]),
        );

        // A `page` row's `expanded` is not a container fold — it EMBEDS a whole
        // child document inline in its parent's body (`collapsible: "always"`, the
        // chevron being the way in). So a page that ARRIVES under a new parent
        // arrives folded, the same deterministic fold `handle-turn-into-page` mints
        // when it promotes a block into a sub-page: a sub-page reads as ONE row in
        // its parent's flow. Gated on the parent actually changing, so reordering a
        // page among its existing siblings writes no document state; and on the
        // moved row being a page, since an ordinary container's `expanded` is
        // legitimate state that travels with it.
        const arrivesFolded =
          before.type === PAGE_BLOCK_TYPE && before.parentId !== body.parentId;
        await updateBlockFields(ctx.tx, params.id, {
          parentId: body.parentId,
          rank: rank.toJSON(),
          ...(arrivesFolded ? { expanded: false } : {}),
        });
        // Reparenting may move the block (and its subtree) into a different page.
        await recomputePageIdSubtree(ctx.tx, params.id);
        // Open the destination so it reveals the freshly-attached child — but NEVER
        // a page destination, by the same rule: opening it would spill THAT page's
        // whole content into ITS parent's body. Both halves are the nav gesture
        // embedding a page in a body that `page-tree`'s "two arrows" note forbids;
        // a sidebar drop is not a request to unfold anything in the document.
        if (destParent && destParent.type !== PAGE_BLOCK_TYPE) {
          // `expanded` is a fold, not content: it never moves the parent's
          // derived `updatedAt`, so re-opening an already-open parent is inert.
          await updateBlockFields(ctx.tx, destParent.id, { expanded: true });
        }

        const [row] = await ctx.tx
          .select()
          .from(liveBlocks)
          .where(eq(liveBlocks.id, params.id))
          .limit(1);
        if (!row) throw new HttpError(404, "Not found after move");
        return { before, row };
      },
    );
    const { before, row } = value;

    // Fan out to reindex subscribers for both the old and the (possibly new) page
    // scope, deduped. The page_blocks content + sidebar live resources invalidate
    // via the L4 DB change-feed on the move write.
    const affected = new Set<string>();
    if (before.pageId !== null) affected.add(before.pageId);
    if (row.pageId !== null) affected.add(row.pageId);
    for (const pageId of affected) {
      await blocksChanged.emit({ pageId });
    }

    return BlockSchema.parse(row);
  },
);
