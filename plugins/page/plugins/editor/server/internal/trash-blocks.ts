import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  nextRankUnder,
  rankAdjacentTo,
} from "@plugins/primitives/plugins/rank/server";
import {
  recordTrashEntry,
  _trashEntries,
} from "@plugins/infra/plugins/trash/server";
import {
  TrashEntrySchema,
  trashEntryIdKind,
  type TrashEntry,
} from "@plugins/infra/plugins/trash/core";
import {
  PAGE_BLOCK_TYPE,
  PAGE_BLOCKS_TRASH_SOURCE,
  PAGES_TRASH_SOURCE,
  pageData,
} from "../../core";
import { _blocks } from "./tables";
import type { BlockRow } from "./forest";
import { collectBlockSubtrees } from "./collect-subtree";
import type { DeletedBlockRow } from "./document-hooks";
import {
  deleteBlockRoots,
  pageBlocksTrashEntry,
  trashBlockRoots,
  untrashBlockRoots,
  updateBlockFields,
  runOnDelete,
  runOnRestore,
  runOnTrash,
  type TrashEntryArgs,
} from "./forest-writer";
import {
  withPageForest,
  pageScopesOf,
  type PageForestCtx,
} from "./page-forest";
import { blocksChanged } from "./tables-events";

/**
 * What the chokepoint did. A discriminated union, not `{trashed, entries?}`: an
 * optional entry list would let a caller silently skip the restore path for a
 * delete that really was trashed (an absorbable failure). `trashed: false` is
 * reachable ONLY when nothing named existed (already trashed, or never there) —
 * every delete of a live row is a trash, so there is always a handle.
 *
 * Each entry carries its SOURCE beside its id: a page root mints a `pages`
 * entry, the leftover rows an anchor entry that is `pages` when a page is
 * involved and `page-blocks` otherwise, and the restore endpoint is addressed
 * by `(sourceId, entryId)`.
 */
export type DeleteBlocksOutcome =
  | { trashed: true; entries: { sourceId: string; entryId: string }[] }
  | { trashed: false };

/**
 * Any drizzle handle these paths can OPEN their locked transaction on: the
 * global handle (production) or a db-test-fixture's throwaway DB (tests). A
 * transaction handle is NOT accepted — `withPageForest` owns its own tx.
 */
export type BlockExecutor = NodePgDatabase;

const parentEq = (parentId: string | null) =>
  parentId === null ? isNull(_blocks.parentId) : eq(_blocks.parentId, parentId);

const toDeleted = (r: BlockRow): DeletedBlockRow => ({
  id: r.id,
  type: r.type,
  pageId: r.pageId,
  parentId: r.parentId,
});

/**
 * THE delete chokepoint for a delete set that may span PAGE boundaries: the
 * id-addressed delete endpoint, the deferred branch of both forest write shapes
 * (a set containing a `type="page"` row), and the agent-origin sweep.
 *
 * Every delete is a trash (soft delete — `deleted_at` + `trash_entry_id` set,
 * FK cascades never fire, so descendants, `page_block_docs`, side-tables, and
 * version history all survive). There is no hard branch left: a page-free set
 * is trashed exactly like a page-containing one, under one `page-blocks` entry
 * instead of a `pages` one. The whole cascade set is loaded and written under
 * the page locks of every page it spans (a sub-page's content lives in its OWN
 * `page_id` partition), so a delete can no longer interleave with an op on any
 * page it touches.
 *
 * Entry partition — ONE gesture, ONE undo:
 *  - each `type="page"` ROOT gets its own independently-restorable `pages` entry
 *    (a bulk delete of two sub-pages ⇒ two entries, the Pages Trash lists both);
 *  - every other row of the operation (non-page roots and their subtrees, and
 *    any row not under a page root) folds into ONE anchor entry: the first page
 *    entry when there is one, else a fresh entry anchored on the first
 *    requested root — in the `pages` source when the set contains a page
 *    anywhere (a sub-page nested under a deleted toggle must stay findable in
 *    the Pages Trash, labelled by that page's title), in the `page-blocks`
 *    source otherwise (labelled by the root's first line).
 *
 * Only LIVE rows are loaded, so an entry is never minted over nothing (an
 * already-trashed nested page keeps its own entry's ownership) — the ledger
 * invariant "an entry exists ⇔ at least one row carries its id".
 *
 * The minted entries are RETURNED (creation order, page roots first): they are
 * the ledger handles a caller needs to offer "Undo" (restore).
 */
export async function deleteBlocksSubtree(
  rootIds: string[],
  executor: BlockExecutor = db,
): Promise<DeleteBlocksOutcome> {
  if (rootIds.length === 0) return { trashed: false };
  const subtreeIds = await collectBlockSubtrees(rootIds, executor);
  if (subtreeIds.length === 0) return { trashed: false };
  const scopes = await pageScopesOf(executor, subtreeIds);

  const { value } = await withPageForest(
    scopes,
    async (ctx): Promise<DeleteBlocksOutcome> => {
      const rows = await ctx.tx
        .select()
        .from(_blocks)
        .where(and(inArray(_blocks.id, subtreeIds), isNull(_blocks.deletedAt)));
      const rowById = new Map(rows.map((r) => [r.id, r]));
      const existingRootIds = rootIds.filter((id) => rowById.has(id));
      if (existingRootIds.length === 0) return { trashed: false };

      // Walk each root's subtree from the already-loaded rows (no extra DB round
      // trips), so entry assignment stays a pure in-memory partition.
      const childrenByParent = new Map<string | null, BlockRow[]>();
      for (const r of rows) {
        const list = childrenByParent.get(r.parentId);
        if (list) list.push(r);
        else childrenByParent.set(r.parentId, [r]);
      }
      const subtreeOf = (rootId: string): string[] => {
        const out: string[] = [];
        const stack = [rootId];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (!rowById.has(id)) continue;
          out.push(id);
          for (const child of childrenByParent.get(id) ?? [])
            stack.push(child.id);
        }
        return out;
      };

      const pageRootIds = existingRootIds.filter(
        (id) => rowById.get(id)!.type === PAGE_BLOCK_TYPE,
      );
      const nonPageRootIds = existingRootIds.filter(
        (id) => rowById.get(id)!.type !== PAGE_BLOCK_TYPE,
      );

      const entries: { sourceId: string; entryId: string }[] = [];
      const claimed = new Set<string>();
      let anchor: { sourceId: string; entryId: string } | null = null;

      for (const pageRootId of pageRootIds) {
        const label = pageData(rowById.get(pageRootId)!).title || "Untitled";
        const entryId = await recordTrashEntry(ctx.tx, {
          sourceId: PAGES_TRASH_SOURCE,
          rootEntityId: pageRootId,
          label,
        });
        entries.push({ sourceId: PAGES_TRASH_SOURCE, entryId });
        anchor ??= { sourceId: PAGES_TRASH_SOURCE, entryId };
        const ids = subtreeOf(pageRootId).filter((id) => !claimed.has(id));
        for (const id of ids) claimed.add(id);
        await trashBlockRoots(ctx.tx, ids, entryId);
      }

      const leftover = rows.filter((r) => !claimed.has(r.id)).map((r) => r.id);
      if (leftover.length > 0) {
        if (anchor === null) {
          const anchorId = nonPageRootIds[0] ?? existingRootIds[0]!;
          const nestedPage = rows.find((r) => r.type === PAGE_BLOCK_TYPE);
          const args: TrashEntryArgs = nestedPage
            ? {
                sourceId: PAGES_TRASH_SOURCE,
                rootEntityId: anchorId,
                label: pageData(nestedPage).title || "Untitled",
                meta: {},
              }
            : pageBlocksTrashEntry({
                pageId: rowById.get(anchorId)!.pageId,
                roots: nonPageRootIds.map((id) => rowById.get(id)!),
                count: leftover.length,
              });
          const entryId = await recordTrashEntry(ctx.tx, args);
          anchor = { sourceId: args.sourceId, entryId };
          entries.push(anchor);
        }
        await trashBlockRoots(ctx.tx, leftover, anchor.entryId);
      }

      // Heavy re-derivation (search deindex, backlink edge deletes) must not hold
      // the page locks.
      const trashed = rows.map(toDeleted);
      ctx.afterCommit(() => runOnTrash(trashed));
      return { trashed: true, entries };
    },
    executor,
  );

  return value;
}

/** What a restore put back — the ids whose flags were cleared. */
export interface RestoreOutcome {
  restoredIds: string[];
}

/**
 * Restore an entry's flagged rows AND consume the entry — the trash sources'
 * `restore` callback and the un-trash prelude of the patch handler.
 *
 * Un-flags exactly the rows carrying this entry's id — no re-walk, so it never
 * over-restores an independently-trashed nested page. The ledger row is deleted
 * in the SAME transaction as the un-flag, which is the restore half of the
 * ledger invariant "an entry exists ⇔ at least one row carries its id" (the
 * trash half is `trashDeletedRows` / `deleteBlocksSubtree`). The trash
 * endpoint's own delete-after-action then finds nothing, which is fine — a
 * source consuming its entry inside `restore` is sanctioned by the primitive.
 *
 * A restored ROOT keeps its stored row; only what the world changed while it
 * was trashed is repaired:
 *  - its `(parent_id, rank)` slot was taken by a live sibling → it is re-ranked
 *    to sit right AFTER that occupant (`rankAdjacentTo`), so it comes back
 *    where it was rather than at the end of the list;
 *  - its parent is gone (purged, or still trashed) → it is reparented to the
 *    nearest place it stays REACHABLE: a `type="page"` root becomes a root page
 *    at the workspace root; any other root lands at the END of its own page's
 *    top level (`parent_id = page_id`, `page_id` kept), so it is still in the
 *    forest every `liveBlocks WHERE page_id = …` read returns and its own
 *    children — which keep their `page_id` — still hang off a row that page
 *    contains. Sending a paragraph to the workspace root would strand it as a
 *    page-less content row no read can reach, with its children showing in the
 *    page under a parent that is not in it.
 * Restore therefore never fails on a slot collision. It DOES fail, loudly, when
 * a non-page root has no live page to land in (its page was purged, or is
 * itself still trashed): restoring a live row under a trashed page would
 * reintroduce exactly the live-under-trashed state the delete chokepoint
 * closes, and the `OnRestore` hooks would reindex it for search under a page
 * that does not exist to the user. Restore the page first.
 *
 * The `OnRestore` hooks run after commit over the restored rows. Idempotent: an
 * entry whose rows are already live restores nothing and is consumed anyway.
 */
export async function untrashBlocks(
  entry: TrashEntry,
  executor: BlockExecutor = db,
): Promise<RestoreOutcome> {
  const flaggedIdRows = await executor
    .select({ id: _blocks.id })
    .from(_blocks)
    .where(eq(_blocks.trashEntryId, entry.id));
  if (flaggedIdRows.length === 0) {
    // Nothing carries the id (a purge that crashed between the row delete and
    // the ledger sweep): consume the dangling entry so the ledger converges.
    await executor.delete(_trashEntries).where(eq(_trashEntries.id, entry.id));
    return { restoredIds: [] };
  }
  // The scopes this restore permutes: every page the flagged rows live in, PLUS
  // the workspace root — a PAGE root whose original parent is gone is
  // reparented there, so it is always a possible destination. A non-page root
  // in that situation lands at its own page's top level, which is one of the
  // flagged rows' own scopes and therefore already locked.
  const scopes = [
    ...(await pageScopesOf(
      executor,
      flaggedIdRows.map((r) => r.id),
    )),
    null,
  ];

  const { value } = await withPageForest(
    scopes,
    async (ctx) => {
      const restored: DeletedBlockRow[] = [];
      const affectedPageIds = new Set<string>();
      const flagged = await ctx.tx
        .select()
        .from(_blocks)
        .where(eq(_blocks.trashEntryId, entry.id));

      const flaggedIds = new Set(flagged.map((r) => r.id));
      const roots = flagged.filter(
        (r) => r.parentId === null || !flaggedIds.has(r.parentId),
      );
      const rootIdSet = new Set(roots.map((r) => r.id));

      for (const root of roots) {
        let targetParentId = root.parentId;
        let targetPageId = root.pageId;
        let targetRank = root.rank;

        if (root.parentId !== null) {
          const [parent] = await ctx.tx
            .select({ id: _blocks.id, deletedAt: _blocks.deletedAt })
            .from(_blocks)
            .where(eq(_blocks.id, root.parentId))
            .limit(1);
          const parentGone = !parent || parent.deletedAt !== null;
          if (parentGone && root.type === PAGE_BLOCK_TYPE) {
            // Original parent purged or still trashed → a page root becomes a
            // root page at the workspace root (pageId null); its own content
            // keeps `page_id = <root>`, so the subtree is unaffected.
            targetParentId = null;
            targetPageId = null;
            targetRank = (
              await nextRankUnder(_blocks, _blocks.parentId, null, ctx.tx)
            ).toJSON();
          } else if (parentGone) {
            // A non-page root (paragraph, toggle, …) has no life outside a page:
            // it lands at the END of its own page's top level, `page_id` kept.
            // Its children keep their `page_id` too, so the subtree stays one
            // page's forest. No live page to land in → loud, nothing moves.
            const pageId = root.pageId;
            if (pageId === null) {
              throw new Error(
                `[page-editor] cannot restore block ${root.id}: a ${root.type} row with no page_id and a vanished parent ${root.parentId} has nowhere to land`,
              );
            }
            const [page] = await ctx.tx
              .select({ id: _blocks.id, deletedAt: _blocks.deletedAt })
              .from(_blocks)
              .where(eq(_blocks.id, pageId))
              .limit(1);
            if (!page || page.deletedAt !== null) {
              throw new HttpError(
                409,
                `Cannot restore block ${root.id}: its container is gone and its page ${pageId} is ${
                  page ? "in the trash" : "permanently deleted"
                }${page ? " — restore the page first" : ""}`,
              );
            }
            targetParentId = pageId;
            targetRank = (
              await nextRankUnder(_blocks, _blocks.parentId, pageId, ctx.tx)
            ).toJSON();
          }
        }

        if (targetParentId === root.parentId) {
          // Rank-collision repair (roots only — subtree-internal ranks are safe).
          // A live sibling may have claimed the root's `(parent_id, rank)` while
          // it was trashed; the partial unique index would reject the un-flag.
          // The root itself is still trashed here, so `deleted_at IS NULL`
          // excludes it from the sibling read.
          const siblings = await ctx.tx
            .select({
              id: _blocks.id,
              parentId: _blocks.parentId,
              rank: _blocks.rank,
            })
            .from(_blocks)
            .where(and(isNull(_blocks.deletedAt), parentEq(targetParentId)));
          const occupant = siblings.find((s) => s.rank === root.rank);
          if (occupant) {
            targetRank = rankAdjacentTo(
              siblings,
              targetParentId,
              occupant.id,
              "after",
              new Set([root.id]),
            ).toJSON();
          }
        }

        if (root.pageId !== null) affectedPageIds.add(root.pageId);
        if (targetPageId !== null) affectedPageIds.add(targetPageId);
        if (root.type === PAGE_BLOCK_TYPE) affectedPageIds.add(root.id);

        await updateBlockFields(ctx.tx, root.id, {
          deletedAt: null,
          trashEntryId: null,
          parentId: targetParentId,
          pageId: targetPageId,
          rank: targetRank,
        });
        restored.push({
          id: root.id,
          type: root.type,
          pageId: targetPageId,
          parentId: targetParentId,
        });
      }

      const nonRootRows = flagged.filter((r) => !rootIdSet.has(r.id));
      if (nonRootRows.length > 0) {
        await untrashBlockRoots(
          ctx.tx,
          nonRootRows.map((r) => r.id),
        );
        for (const r of nonRootRows) {
          if (r.pageId !== null) affectedPageIds.add(r.pageId);
          restored.push(toDeleted(r));
        }
      }

      // Consume the entry in the same transaction as the un-flag: no row carries
      // its id any more, so the ledger row must go with them.
      await ctx.tx.delete(_trashEntries).where(eq(_trashEntries.id, entry.id));

      return { restored, affectedPageIds };
    },
    executor,
  );

  const { restored, affectedPageIds } = value;
  if (restored.length === 0) return { restoredIds: [] };

  await runOnRestore(restored);
  // The page_blocks live resources refresh automatically via the L4 change-feed
  // on the un-flag UPDATE; this fans out the cross-plugin `blocksChanged` event
  // so search / links / reminders re-derive. Rides `executor` so a test DB emits
  // against its own (subscriber-less) trigger table — a no-op there.
  for (const pageId of affectedPageIds) {
    await blocksChanged.emit({ pageId }, { tx: executor });
  }
  return { restoredIds: restored.map((r) => r.id) };
}

/**
 * The trash sources' `restore` callback: {@link untrashBlocks} with its outcome
 * discarded, since the primitive's contract is `Promise<void>` (the endpoint
 * answers `{ ok: true }` and the restored ids reach the client through the
 * live resources).
 */
export async function restoreTrashedBlocks(entry: TrashEntry): Promise<void> {
  await untrashBlocks(entry);
}

/**
 * Restore the entry a trashed row names, by id — the patch handler's un-trash
 * prelude (a `create` whose id matches ANY trashed row brings that row's whole
 * entry back), so the handler never names the ledger table itself.
 *
 * A flagged row whose entry is missing is a LOUD error, not a skip: the flags
 * and the ledger row are written and cleared in the same transactions
 * (`trashDeletedRows` / {@link untrashBlocks}) and purge deletes the rows
 * before the entry, so the state is unreachable by construction — reaching it
 * means a writer bypassed the chokepoints.
 */
export async function restoreEntryById(
  entryId: string,
  executor: BlockExecutor = db,
): Promise<RestoreOutcome> {
  const [row] = await executor
    .select()
    .from(_trashEntries)
    .where(eq(_trashEntries.id, trashEntryIdKind.key(entryId)))
    .limit(1);
  if (!row) {
    throw new Error(
      `[page-editor] trash entry ${entryId} is named by a trashed block but has no ledger row — ` +
        "the flags and the ledger disagree, which the chokepoints make impossible",
    );
  }
  return untrashBlocks(TrashEntrySchema.parse(row), executor);
}

/**
 * The `page-blocks` ledger entries history restore may revive for page
 * `pageId`: the distinct entries carrying one of `ids` as a row TRASHED FROM
 * THIS PAGE (`page_id = pageId`), restricted to entries whose every row is on
 * this page. Restore then brings each back whole through
 * {@link restoreEntryById} — the ledger allows nothing smaller.
 *
 * Two kinds of entry are deliberately never returned:
 *  - **`pages` entries.** Reviving one would revive a sub-page, and a restore
 *    never changes whether a sub-page exists. A content row trashed together
 *    with a sub-page is left in the trash; restore copies it instead.
 *  - **An entry holding a row of ANOTHER page.** Reviving it would bring rows
 *    back on a page this restore does not hold the lock of and will not write —
 *    they would stay revived there. No write shape mints such a `page-blocks`
 *    entry today (the op and patch handlers trash one page's forest, and the
 *    composite splits a multi-page delete per page), but the id-addressed
 *    chokepoint could be handed roots on two pages; restore copies those rows
 *    rather than touch the other page.
 *
 * Raw because it reads trashed rows, which is why it lives in this file.
 */
export async function pageBlocksEntriesAmong(
  executor: BlockExecutor,
  pageId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await executor
    .selectDistinct({ entryId: _trashEntries.id })
    .from(_blocks)
    .innerJoin(_trashEntries, eq(_trashEntries.id, _blocks.trashEntryId))
    .where(
      and(
        inArray(_blocks.id, [...ids]),
        eq(_blocks.pageId, pageId),
        isNotNull(_blocks.deletedAt),
        eq(_trashEntries.sourceId, PAGE_BLOCKS_TRASH_SOURCE),
        sql`NOT EXISTS (
          SELECT 1 FROM ${_blocks} AS other
          WHERE other.trash_entry_id = ${_trashEntries.id}
            AND other.page_id IS DISTINCT FROM ${pageId}
        )`,
      ),
    );
  return rows.map((r) => r.entryId).sort();
}

/**
 * Purge (permanent hard-delete) a batch of trashed entries — BOTH trash
 * sources' `purge` callback, run by the retention sweep at 30 days OR by
 * "Delete permanently". Batched: ONE subtree collect over every entry's roots,
 * ONE lock set, ONE transaction. Collect the still-trashed rows (roots +
 * descendants), fire the `OnDelete` hooks over the FULL set (so
 * `deleteVersions` / search deindex run — purge IS the deferred hard delete),
 * then DELETE the roots so the FK cascades finally reclaim content,
 * `page_block_docs`, `page_links`, ext side-tables, and attachment links.
 * Idempotent: an entry whose rows are already gone contributes nothing.
 */
export async function purgeTrashedBlocks(
  entries: TrashEntry[],
  executor: BlockExecutor = db,
): Promise<void> {
  if (entries.length === 0) return;
  const flagged = await executor
    .select({ id: _blocks.id, parentId: _blocks.parentId })
    .from(_blocks)
    .where(
      inArray(
        _blocks.trashEntryId,
        entries.map((e) => e.id),
      ),
    );
  if (flagged.length === 0) return; // already purged or restored

  const flaggedIds = new Set(flagged.map((r) => r.id));
  const rootIds = flagged
    .filter((r) => r.parentId === null || !flaggedIds.has(r.parentId))
    .map((r) => r.id);

  // The full cascade set for the destroy hooks — collectBlockSubtrees walks
  // `parent_id` and deliberately keeps seeing trashed rows.
  const subtreeIds = await collectBlockSubtrees(rootIds, executor);
  const scopes = await pageScopesOf(executor, subtreeIds);

  await withPageForest(
    scopes,
    async (ctx: PageForestCtx) => {
      const rows = await ctx.tx
        .select({
          id: _blocks.id,
          type: _blocks.type,
          pageId: _blocks.pageId,
          parentId: _blocks.parentId,
        })
        .from(_blocks)
        .where(inArray(_blocks.id, subtreeIds));
      await runOnDelete(ctx, rows);
      await deleteBlockRoots(ctx.tx, rootIds);
    },
    executor,
  );
}
