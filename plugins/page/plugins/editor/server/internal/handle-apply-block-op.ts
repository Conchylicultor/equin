import { asc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { applyBlockOpEndpoint } from "../../core/endpoints";
import {
  applyBlockOp,
  blockOpContextOf,
  type BlockNode,
  type BlockOp,
  type BlockOpContext,
} from "../../core/block-ops";
import { BlockSchema, PAGE_BLOCK_TYPE, type Block } from "../../core/schemas";
import { liveBlocks } from "./live-blocks";
import { Editor as BlockRegistry } from "./block-registry";
import { withPageForest, type ForestExecutor } from "./page-forest";
import { writeForestTarget } from "./forest-writer";
import { rowToNode } from "./reconcile";
import { notifyStructuralChange } from "./notify-structural-change";
import { deleteBlocksSubtree } from "./trash-blocks";
import {
  claimLockScopes,
  claimedPageIds,
  copiedPages,
  copyPageContent,
  readPageClaims,
} from "./page-clipboard";
import { blocksChanged } from "./tables-events";

/**
 * Single authoritative structural edit. Load the page's blocks, run the pure
 * `applyBlockOp` reducer to compute the target tree, diff it against the loaded
 * rows, and persist the {insert, update, delete} diff in one transaction. All
 * tree/rank math lives in the reducer; this handler only diffs + persists +
 * notifies. Replaces the per-keystroke split/merge/indent/outdent handlers.
 */
/**
 * The reducer's type facts, minted from the server's OWN block registry — the
 * mirror of the web side's `useBlockOpContext()` over `Editor.Block`. Both
 * runtimes must hand `applyBlockOp` the same context: the client predicts the
 * forest with it (the optimistic overlay) and this handler commits with it, so a
 * disagreement would make an op apply differently on each side and never
 * confirm. The two registries differ; `blockOpContextOf` is why the DERIVATION
 * cannot, so a new reducer fact reaches both sides at once.
 *
 * Recomputed per request rather than memoized at module eval: contributions are
 * collected at boot, well after this module is evaluated, and it is a couple of
 * filters over a couple of dozen handles (see `block-registry.ts` on why no
 * eager mirror lives there).
 */
export function blockOpCtx(): BlockOpContext {
  return blockOpContextOf(BlockRegistry.BlockData.getContributions());
}

/**
 * `move` / `bulkMove` mint their rank IN THE REDUCER, from the sibling set of
 * the forest handed to it — this page's. So the destination's sibling space must
 * lie inside this page, or the key is arithmetic over a partial list and
 * collides with the siblings it cannot see (the same hazard
 * `MoveBlockBodySchema` and `planBulkMove`'s `destSiblings` doc name).
 *
 * Exactly two destinations qualify: the page's own top level, and a NON-page row
 * of this page. A sub-page row's children are keyed to that sub-page and are
 * absent from a page-scoped load, so it is refused here — a cross-page drop is
 * not one page's op, and the composite client store routes it to the id-scoped
 * `moveBlock` endpoint, which locks both forests.
 *
 * A loud 400, never a silent clamp: a request reaching here with an out-of-page
 * destination means a client computed an intent this endpoint cannot honour.
 */
function assertDestinationInPage(
  rows: BlockNode[],
  pageId: string,
  parentId: string | null,
): void {
  if (parentId === pageId) return;
  const parent =
    parentId === null ? undefined : rows.find((r) => r.id === parentId);
  if (!parent || parent.type === PAGE_BLOCK_TYPE) {
    throw new HttpError(
      400,
      `Destination parent ${parentId ?? "null"} is not inside page ${pageId}; ` +
        `a cross-page move must use POST /api/blocks/:id/move`,
    );
  }
}

/**
 * THE op write: the endpoint's whole body, parameterized on the executor so a
 * db-test-fixture suite drives exactly what production runs (the mirror of
 * `applyPageBlockPatch`).
 */
export async function applyPageBlockOp(
  pageId: string,
  body: BlockOp,
  executor: ForestExecutor = db,
): Promise<{ blocks: Block[]; watermark: string }> {
  const params = { pageId };
  // ONE locked transaction spans the load, the reduce and the writes, because
  // this handler is a read-modify-write over the whole forest and its UPDATE
  // reasserts every column of every changed row. `withPageForest` is what makes
  // "the read is under the lock" true by construction — `ctx.forest()` is the
  // only way to read, and it exists only inside the transaction. Everything that
  // must NOT hold the lock (the delete hooks' re-push callbacks, the notify
  // fan-out, the page-delete chokepoint, the final read-back) runs after it.
  //
  // A paste that CLAIMS a cut sub-page (its node keeps the page's own id —
  // `PageSource`) also writes the page's former scope and the partitions
  // inside it, so those join the lock set. Resolved unlocked: it only names
  // locks, and the claims are re-read under them.
  const extraScopes = await claimLockScopes(executor, claimedPageIds(body));
  const { value, watermark } = await withPageForest(
    [params.pageId, ...extraScopes],
    async (ctx) => {
      // The lock set may span more than this page; the op's forest is this
      // page's alone.
      const rows = (await ctx.forest()).filter(
        (r) => r.pageId === params.pageId,
      );
      const before = rows.map(rowToNode);
      if (body.kind === "move" || body.kind === "bulkMove") {
        assertDestinationInPage(before, params.pageId, body.parentId);
      }
      const claims = await readPageClaims(ctx, body, params.pageId);
      const after = applyBlockOp(before, body, blockOpCtx());

      // Reconciles, persists, and trashes the AUTHORITATIVE delete set — the
      // one this transaction really removes — inline under one `page-blocks`
      // entry. There is no longer a predicted set read outside the lock, so
      // there is nothing for the two to disagree about.
      const write = await writeForestTarget(ctx, before, after, claims);

      // A copied sub-page lands as its page row alone (its content is not in
      // the forest a copy serializes); clone the source's content under it,
      // in this same transaction. Only pages the write really inserted — a
      // refused paste inserted nothing to fill.
      const inserted = new Set(write.createdPageIds);
      const beforeIds = new Set(before.map((n) => n.id));
      const copies = await copyPageContent(
        ctx,
        copiedPages(body).filter((c) => inserted.has(c.copyPageId)),
        new Set(after.filter((n) => !beforeIds.has(n.id)).map((n) => n.id)),
      );
      write.createdPageIds.push(...copies.createdPageIds);

      // pageId invariant: NO op reachable through this endpoint crosses a page
      // boundary, so surviving nodes keep their pageId and new nodes inherit it
      // from their parent/sibling. (A claimed page row does change scope — into
      // this page — but its own content is keyed by its id, which a move never
      // changes; and a copy's rows are keyed by the page the copy created.) — and the hot keystroke path can skip
      // `recomputePageIdSubtree` entirely (it is a `WITH RECURSIVE` per edit).
      //
      // That is ENFORCED, not assumed, and re-check both halves before relying on
      // it: the reducer no-ops when a `page` row would be crossed (`applyIndent`
      // and `applyMerge` on a `page` previous sibling, `applySplit` on a `page`
      // row, `applyOutdent` on a `page` parent), and the reparenting ops (`move`,
      // `bulkMove`) are refused above unless their destination is inside this
      // page. A cross-page move is `handleMoveBlock`'s, which locks both forests
      // and does recompute.

      return { write };
    },
    executor,
  );
  const { write } = value;

  // Route a page-containing delete through the trash chokepoint (its
  // sub-pages' own locks + `pages` entries). Runs after the write transaction
  // so the reducer's other diffs land first; the delete set is disjoint from
  // the insert/update set, and the chokepoint takes the page locks it needs
  // itself.
  if (write.deferredToChokepoint && write.deleteRootIds.length > 0) {
    await deleteBlocksSubtree(write.deleteRootIds, executor);
  }

  // --- Notify (shared with the patch handler) --------------------------------
  // The shared helper emits `blocksChanged` for this page and fans out per
  // emptied sub-page in the deleted subtree, and per sub-page the op created
  // (a paste or duplicate of one).
  await notifyStructuralChange(
    {
      pageId: params.pageId,
      deletedRows: write.deletedRows,
      createdPageIds: write.createdPageIds,
    },
    executor,
  );
  // A page claimed from another page left that page's content.
  for (const from of new Set(write.claimedFromPageIds)) {
    if (from !== params.pageId) {
      await blocksChanged.emit({ pageId: from }, { tx: executor });
    }
  }

  // Return the reloaded LIVE page rows (mirrors the live push payload).
  const finalRows = await executor
    .select()
    .from(liveBlocks)
    .where(eq(liveBlocks.pageId, params.pageId))
    .orderBy(asc(liveBlocks.rank), asc(liveBlocks.createdAt));
  return { blocks: finalRows.map((r) => BlockSchema.parse(r)), watermark };
}

export const handleApplyBlockOp = implement(
  applyBlockOpEndpoint,
  ({ params, body }) => applyPageBlockOp(params.pageId, body),
);
