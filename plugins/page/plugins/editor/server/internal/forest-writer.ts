import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  recordTrashEntry,
  _trashEntries,
} from "@plugins/infra/plugins/trash/server";
import { trashEntryIdKind } from "@plugins/infra/plugins/trash/core";
import { textOf, type BlockNode } from "../../core";
import type { Block } from "../../core";
import { PAGE_BLOCK_TYPE, PAGE_BLOCKS_TRASH_SOURCE } from "../../core";
import { namesField, type BlockFieldChanges } from "../../core";
import { _blocks } from "./tables";
import type { BlockRow } from "./forest";
import {
  parseBlockData,
  rewriteBlockData,
  type BlockDataRewrite,
} from "./parse-block-data";
import { reconcileBlocks } from "./reconcile";
import { BlockLifecycle, type DeletedBlockRow } from "./document-hooks";
import type { PageForestCtx, PageForestTx } from "./page-forest";
import { markDocOrderDirty } from "./doc-order-dirty";

/**
 * THE only module in the repo that may name `_blocks` in a MUTATION position.
 *
 * Every export takes a {@link PageForestTx} — a transaction proven to hold the
 * write lock on the pages it touches — as a required parameter, so an unlocked
 * forest write is a tsc error rather than a convention. The direct way around
 * that (importing `_blocks` and writing it by hand somewhere else) is closed by
 * the `page-editor/no-adhoc-forest-write` lint rule, which exempts this file
 * alone. Two halves of one guardrail; neither is sufficient.
 *
 * There are exactly TWO write shapes, and keeping them distinct is deliberate:
 *
 *  - {@link writeForestTarget} — the op handler's whole write. Reconcile
 *    before→after, trash the AUTHORITATIVE delete set, persist the rest.
 *  - {@link writeBlockPatch} — the patch handler's whole write. Trash,
 *    rank-park, then the FIELD-SCOPED columns each update names. It must stay
 *    field-scoped: a "hand me the new forest" contract would regress
 *    `BlockPatch` back into whole-row writes, the exact thing
 *    `research/2026-07-28-page-block-write-ownership.md` removed.
 *
 * **No hard delete of live content.** Neither write shape ever `DELETE`s a row
 * the user can see: every delete is a trash — the rows are flagged under ONE
 * ledger entry per operation (`trashDeletedRows`), and their content docs, ext
 * side-tables and version history survive until purge. The real `DELETE`
 * ({@link deleteBlockRoots}) is reachable from purge alone. History restore
 * used to be the other caller (it wiped a page's content and re-inserted it
 * with fresh ids); it now writes through {@link writeForestTarget} like the op
 * handler, so it trashes too.
 * `research/2026-09-09-page-data-based-text-undo-entries-v2.md` §3,
 * `research/2026-09-11-page-history-restore-preserves-block-identity.md`.
 */

/**
 * Every column an INSERT may name. Two are not:
 *
 *  - `updatedAt` is DERIVED (`deriveUpdatedAt` in `tables.ts`) — it defaults on
 *    insert and the table's trigger moves it on update — so no write of
 *    `page_blocks` can spell it.
 *  - `docRank` is WRITER-derived: `withPageForest`'s reconcile mints it from
 *    document order for every partition a write touched ({@link writeDocRanks}
 *    is its one writer), so no caller can hand one in — not a handler, and not a
 *    request body.
 */
export type NewBlockRow = Omit<
  typeof _blocks.$inferInsert,
  "updatedAt" | "docRank"
>;

/**
 * The columns a field-scoped UPDATE may name. `id` is excluded — identity is not
 * a field — and `createdAt` is excluded because a row is created once. The write
 * says exactly what it changes, so a caller can never discover a column it did
 * not author; `updatedAt` is not writable at all (see {@link NewBlockRow}) — the
 * trigger moves it iff a counted column (parent, type, data, rank, trash flag)
 * really changed.
 *
 * `data` takes the {@link BlockDataRewrite} brand rather than an insert's plain
 * `BlockData`: rewriting an EXISTING row's payload must also prove it keeps the
 * row's author, and `rewriteBlockData` is the only thing that mints the proof —
 * save `rekindPageData`, the one write whose whole content is a page's new
 * kind (`setPageKind`).
 */
export type BlockColumnChanges = Partial<
  Omit<NewBlockRow, "id" | "createdAt" | "data"> & { data: BlockDataRewrite }
>;

// ---------------------------------------------------------------------------
// Low-level column writers
// ---------------------------------------------------------------------------
//
// Each one that can change a row's PLACEMENT — its parent, rank, type, page
// partition or trash flag — marks the partitions it wrote as doc-order dirty
// (`doc-order-dirty.ts`), so `withPageForest` re-mints their `doc_rank` before
// commit. The marks live here, at the bottom, so every composite writer above
// inherits them; a data-only write (the text projection, a rename, an icon, a
// fold) names none of those columns and costs the reconcile nothing.

/**
 * The columns whose change can move a page row within, into or out of its
 * sidebar group — the ones {@link updateBlockFields} marks for.
 */
const PLACEMENT_COLUMNS = [
  "parentId",
  "rank",
  "type",
  "pageId",
  "deletedAt",
] as const satisfies readonly (keyof BlockColumnChanges)[];

/**
 * Insert rows in the given order. Callers must order parent-before-descendant —
 * `parent_id` is a self-FK.
 */
export async function insertBlocks(
  tx: PageForestTx,
  rows: NewBlockRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(_blocks).values(rows);
  markDocOrderDirty(
    tx,
    rows.map((r) => r.pageId ?? null),
  );
}

/**
 * Write exactly the columns `changes` names onto one row.
 *
 * A write naming a placement column marks the row's partition — BOTH of them
 * when it names `pageId`, read before the write so a row leaving a group marks
 * the group it left. A write turning the row into anything but a page clears
 * its `doc_rank` in the same statement: only page rows carry one.
 */
export async function updateBlockFields(
  tx: PageForestTx,
  id: string,
  changes: BlockColumnChanges,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  const placement = PLACEMENT_COLUMNS.some((c) => changes[c] !== undefined);
  if (!placement) {
    await tx.update(_blocks).set(changes).where(eq(_blocks.id, id));
    return;
  }
  if (changes.pageId !== undefined) {
    const [old] = await tx
      .select({ pageId: _blocks.pageId })
      .from(_blocks)
      .where(eq(_blocks.id, id));
    if (old) markDocOrderDirty(tx, [old.pageId]);
  }
  const leavesPages =
    changes.type !== undefined && changes.type !== PAGE_BLOCK_TYPE;
  const written = await tx
    .update(_blocks)
    .set(leavesPages ? { ...changes, docRank: null } : changes)
    .where(eq(_blocks.id, id))
    .returning({ pageId: _blocks.pageId });
  markDocOrderDirty(
    tx,
    written.map((r) => r.pageId),
  );
}

/**
 * THE `doc_rank` writer — the only one. Called by the reconcile alone
 * (`doc-rank.ts`), with the changes `planDocRanks` derived from document order
 * under the lock; one statement however many rows moved. Marks nothing: a
 * re-mint changes no placement, only the key that states it.
 *
 * `docRank` is `touchedBy: false`, so a re-mint never moves `updated_at` (a
 * sibling re-spaced around a drag was not edited).
 */
export async function writeDocRanks(
  tx: PageForestTx,
  changes: readonly { id: string; docRank: string }[],
): Promise<void> {
  if (changes.length === 0) return;
  await tx.execute(sql`
    UPDATE ${_blocks}
       SET doc_rank = v.doc_rank
      FROM unnest(
             ${sql.param(changes.map((c) => c.id))}::text[],
             ${sql.param(changes.map((c) => c.docRank))}::text[]
           ) AS v(id, doc_rank)
     WHERE ${_blocks}.id = v.id
  `);
}

/**
 * HARD-delete a set of delete ROOTS; the self-FK `ON DELETE CASCADE` reclaims
 * their descendants (and their `page_block_docs`, ext side-tables, and
 * attachment links). Roots only — deleting every id would be redundant, not
 * safer.
 *
 * Reachable from PURGE only (`purgeTrashedBlocks`, the trash sources' deferred
 * hard delete). A user-facing delete never lands here — it is a trash
 * ({@link trashDeletedRows}), so the content survives for undo and for the
 * 30-day grace period.
 */
export async function deleteBlockRoots(
  tx: PageForestTx,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const deleted = await tx
    .delete(_blocks)
    .where(inArray(_blocks.id, ids))
    .returning({ pageId: _blocks.pageId });
  markDocOrderDirty(
    tx,
    deleted.map((r) => r.pageId),
  );
}

/**
 * Which of `ids` name a row that exists at all — live OR trashed, on any page.
 * History restore's one question about a version block it cannot find live on
 * the page: may it come back under its ORIGINAL id (no row has that id, so the
 * insert cannot collide), or must it be a fresh-id copy (the id is taken — live
 * elsewhere, or in the trash under an entry the restore did not revive)?
 *
 * Raw on purpose: a trashed row still owns its id, so a live-only read would
 * answer "free" for an id whose INSERT then fails on the primary key. Read under
 * the caller's lock, so the answer holds until its write lands.
 */
export async function existingBlockIdsAmong(
  tx: PageForestTx,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: _blocks.id })
    .from(_blocks)
    .where(inArray(_blocks.id, [...ids]));
  return new Set(rows.map((r) => r.id));
}

/**
 * SOFT-delete (trash) a set of rows under one ledger entry. Only rows still LIVE
 * are flagged, so an already-trashed nested page keeps its own entry's ownership
 * and restoring the outer entry leaves the inner one trashed.
 */
export async function trashBlockRoots(
  tx: PageForestTx,
  ids: string[],
  entryId: string,
): Promise<void> {
  if (ids.length === 0) return;
  const trashed = await tx
    .update(_blocks)
    .set({ deletedAt: new Date(), trashEntryId: entryId })
    .where(and(inArray(_blocks.id, ids), isNull(_blocks.deletedAt)))
    .returning({ pageId: _blocks.pageId });
  markDocOrderDirty(
    tx,
    trashed.map((r) => r.pageId),
  );
}

/**
 * Clear the trash flags on a set of rows, leaving every other column alone —
 * the subtree-internal half of a restore, whose `(parent_id, rank)` pairs were
 * never contended (the subtree moved as one body). A ROOT whose slot may have
 * been taken while it was trashed is repaired by its caller through
 * {@link updateBlockFields} instead.
 */
export async function untrashBlockRoots(
  tx: PageForestTx,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const restored = await tx
    .update(_blocks)
    .set({ deletedAt: null, trashEntryId: null })
    .where(inArray(_blocks.id, ids))
    .returning({ pageId: _blocks.pageId });
  markDocOrderDirty(
    tx,
    restored.map((r) => r.pageId),
  );
}

// ---------------------------------------------------------------------------
// Park-then-place (the `(parent_id, rank)` unique-index protocol)
// ---------------------------------------------------------------------------

/** Where a row sits now, and the `(parentId, rank)` pair the batch will give it. */
export interface RankPlacement {
  id: string;
  /** The parent the row sits under right now — the scope it is parked in. */
  currentParentId: string | null;
  /** The parent it will sit under after phase 2. */
  parentId: string | null;
  /** The final rank, as the stored string. */
  rank: string;
}

/** The `(parentId, rank)` pair a row the batch will INSERT is going to occupy. */
export type IncomingPlacement = Pick<RankPlacement, "parentId" | "rank">;

/**
 * Phase 1 of **park-then-place**: bump every row in `placements` to a scratch
 * ("park") rank *under the parent it already sits below*, chosen strictly
 * greater than every rank that will exist under that parent — both the ranks
 * stored there now and the final ranks this batch is about to write there. The
 * caller then runs its normal per-row UPDATE with the final `(parentId, rank)`
 * (phase 2), in any order.
 *
 * It permutes the non-deferrable `(parent_id, rank)` partial unique index, so it
 * is never legal unlocked — hence the {@link PageForestTx}.
 *
 * ## Why a scratch value is required
 *
 * `page_blocks` carries a per-tuple `UNIQUE NULLS NOT DISTINCT (parent_id,
 * rank)` index. It is **not** `DEFERRABLE` (drizzle cannot emit that), so every
 * single-row UPDATE is checked immediately. A batch that permutes ranks among
 * siblings therefore transiently duplicates a pair mid-loop:
 *
 * - the `bulkMove` op mints its `nBetween` window *excluding* the moving
 *   ids, so a computed key can equal a rank a still-unmoved sibling holds.
 *   (Under parent P with siblings `B="a1"`, `C="a2"`, `D="a3"`, moving `{B,D}`
 *   after `C`: the window `("a2", null)` yields `["a3","a4"]`, and `B → "a3"`
 *   lands while `D` still holds `"a3"`.)
 * - `handlePatchBlocks` writes client-computed rows verbatim; undoing a swap
 *   re-assigns two rows to each other's ranks.
 *
 * Re-ordering the UPDATEs cannot save either case: a 2-cycle (a plain swap) has
 * no safe order. Only a scratch value does.
 *
 * ## Why phase 2 is then unconditionally safe
 *
 * Let `floor(p) = max(every rank currently stored under p, every final rank the
 * batch writes under p)`, over both `placements` and `incoming`. Park keys under
 * `p` are `nBetween(floor(p), null, n)` — mutually distinct and each strictly
 * greater than `floor(p)`.
 *
 * - *Phase 1 is safe*: a park key exceeds every rank currently under `p`, and
 *   the keys are distinct, so no two parked rows meet.
 * - *Phase 2 is safe*: when a row is written to its final `(p, r)`, the only
 *   rows under `p` are (a) rows the batch never touched, whose ranks are
 *   `≤ floor(p)` but cannot equal `r` unless the caller handed two rows the
 *   same pair, and (b) still-parked rows, whose keys are `> floor(p) ≥ r`.
 *   Order within phase 2 is therefore irrelevant.
 *
 * Any collision that survives means the caller computed two identical final
 * pairs — a genuine bug, and the index fires loudly rather than silently
 * dropping an ordering.
 *
 * ## Why parking happens under the CURRENT parent
 *
 * Parking never rewrites `parent_id`. That keeps phase 1 free of foreign-key
 * order dependencies: a patch may reparent an existing row under a row the same
 * batch has not INSERTed yet, and parking it into that parent up front would
 * violate the self-FK. Vacating the row's old pair is all phase 1 owes phase 2,
 * and a pure rank bump does exactly that.
 *
 * Rows whose `(parentId, rank)` is unchanged need no parking — see
 * {@link pairChanged}; an UPDATE writing a row's own current pair is invisible
 * to the index.
 */
export async function parkRanks(
  tx: PageForestTx,
  args: {
    /** Existing rows being re-ranked and/or re-parented. */
    placements: RankPlacement[];
    /** Pairs the batch will INSERT afterwards. They only widen the floors. */
    incoming?: IncomingPlacement[];
  },
): Promise<void> {
  const { placements, incoming = [] } = args;
  if (placements.length === 0) return;

  // Final ranks landing under each parent — from re-ranked AND inserted rows.
  const finalsUnder = new Map<string | null, string[]>();
  for (const p of [...placements, ...incoming]) {
    const list = finalsUnder.get(p.parentId);
    if (list) list.push(p.rank);
    else finalsUnder.set(p.parentId, [p.rank]);
  }

  // Group the rows to park by the parent they currently live under.
  const parkedUnder = new Map<string | null, RankPlacement[]>();
  for (const p of placements) {
    const list = parkedUnder.get(p.currentParentId);
    if (list) list.push(p);
    else parkedUnder.set(p.currentParentId, [p]);
  }

  for (const [parentId, rows] of parkedUnder) {
    // Max rank CURRENTLY stored under this parent, over ALL its rows — including
    // ones this batch is moving, and (when the parent is a `page` block) its
    // content rows, which a page-scoped `loadPageBlocks` never returns.
    // `rank_text` is a C-collation domain, so byte order IS rank order.
    const [last] = await tx
      .select({ rank: _blocks.rank })
      .from(_blocks)
      .where(
        parentId === null
          ? isNull(_blocks.parentId)
          : eq(_blocks.parentId, parentId),
      )
      .orderBy(desc(_blocks.rank))
      .limit(1);

    const candidates = [...(finalsUnder.get(parentId) ?? [])];
    if (last) candidates.push(last.rank);
    // `rows` is non-empty and every parked row contributes its own final rank to
    // some parent, but not necessarily to THIS one (it may be moving away) — so
    // `last` is what guarantees a floor when the parent receives no finals. A
    // parent with a parked row always has at least that one row stored under it.
    const floor = candidates.reduce((a, b) => (a > b ? a : b));

    const park = Rank.nBetween(Rank.from(floor), null, rows.length);
    for (let i = 0; i < rows.length; i++) {
      await updateBlockFields(tx, rows[i]!.id, { rank: park[i]!.toJSON() });
    }
  }
}

/**
 * `true` when the batch moves a row off the `(parent_id, rank)` pair it
 * occupies — i.e. it must be parked before the final writes land.
 */
export function pairChanged(
  current: { parentId: string | null; rank: string },
  next: { parentId: string | null; rank: string },
): boolean {
  return current.parentId !== next.parentId || current.rank !== next.rank;
}

// ---------------------------------------------------------------------------
// The delete branch, shared by both write shapes
// ---------------------------------------------------------------------------

/**
 * What a forest write removed from the page's live content.
 *
 * Every removal is a TRASH, and the only question is WHERE it happens:
 *
 *  - a page-free delete set is trashed INLINE, in this write's own transaction
 *    (`trashDeletedRows`): one ledger entry in the `page-blocks` source, whose
 *    id is `trashedEntryId`. The hot path stays one transaction.
 *  - a delete set containing a `type="page"` row is DEFERRED: a page's own
 *    content lives in its own `page_id` partition under its own lock, which
 *    this transaction does not hold, so the caller routes `deleteRootIds`
 *    through `deleteBlocksSubtree` (which takes every page lock it needs) AFTER
 *    the transaction. `deferredToChokepoint` is a real branch, not a flag to
 *    ignore — a page silently cascading here is the 2026-07-10 data-loss bug.
 *
 * Two rules hold for both, and both follow from the trash no longer being a
 * `DELETE` (whose FK cascade ran after the moves, so it got them for free):
 *
 *  - **The set is closed over the forest AS WRITTEN** ({@link deleteClosureOf}):
 *    a row this same write re-homes out of a removed block (an `unwrap`'s
 *    promoted children, a merge's adopted ones, the redo of either) is not that
 *    block's descendant any more, so it is never trashed. A surviving row whose
 *    as-written parent chain still reaches a removed row — an orphan a buggy
 *    reducer or patch left behind — IS trashed: the closure stays the guarantee
 *    that no live row hangs off a trashed one.
 *  - **The inline trash runs before anything is placed**: before `parkRanks`,
 *    the inserts and the updates. The live unique indexes are partial on
 *    `deleted_at IS NULL`, so a trashed row vacates its `(parent_id, rank)`
 *    slot, and a survivor or insert may land exactly where a row this write
 *    removes sat. The deferred branch cannot: its rows stay live until the
 *    chokepoint runs after commit, so a placement onto a slot one of them holds
 *    is still a unique violation there. No caller produces that shape today.
 *
 * `OnDelete` fires on neither: nothing here is hard-deleted.
 */
export interface ForestWriteResult {
  /**
   * Rows removed from the page's live content, AUTHORITATIVE (reconciled under
   * the lock), with the parentage the write LEFT them in — which is what is
   * stored under the flags, and so what `untrashBlocks` will read to find the
   * entry's roots. A row the write names for deletion is never also written, so
   * for every one of them this is simply its pre-write parentage; the two differ
   * only for an orphan the closure caught.
   */
  deletedRows: DeletedBlockRow[];
  /**
   * Deleted ids whose (as-written) parent is not itself deleted — the cascade
   * roots. Always ids the write NAMED for deletion: a row the closure reached
   * was reached through its parent.
   */
  deleteRootIds: string[];
  /**
   * The delete set contained a page row, so it was NOT trashed here — the
   * caller must hand `deleteRootIds` to `deleteBlocksSubtree` after commit.
   */
  deferredToChokepoint: boolean;
  /**
   * The `page-blocks` ledger entry this write minted for its delete set, or
   * `null` when the set was empty or deferred. Non-null ⇔ rows were trashed
   * inline — exactly when the caller has a handle to offer as "Undo".
   */
  trashedEntryId: string | null;
  /**
   * The `type="page"` rows this write INSERTED — pages that did not exist before
   * it. The mirror of the page rows in {@link deletedRows}: a new page's content
   * appeared under a `page_id` nobody has announced, so the caller emits one
   * `blocksChanged` per id (`notifyStructuralChange`), which is what drives
   * search, history, links and attachments for it. A markdown apply minting an
   * `<agent-page>`, a paste or a duplicate of a sub-page all land here.
   */
  createdPageIds: string[];
  /**
   * Pages this write CLAIMED rather than inserted (see {@link PageClaim}), with
   * the page scope each one left. The caller announces those former scopes: a
   * page moving out of a page changed that page's content too.
   */
  claimedFromPageIds: string[];
}

/**
 * An existing `type="page"` row a paste names by its own id — the first paste of
 * a cut, which MOVES the page instead of copying it (`PageSource` in
 * `core/serialized-block.ts`). The reducer plans it like any inserted node; the
 * writer places the stored row there instead of inserting a new one, so the
 * page keeps its id, its data and every row keyed on it.
 *
 * `trashEntryId` is the entry the row is flagged under (the cut trashed it), or
 * `null` when it is live somewhere else (the cut was undone, or restored from
 * the Trash). A trashed claim takes back its whole subtree from that entry.
 */
export interface PageClaim {
  pageId: string | null;
  trashEntryId: string | null;
}

/** The ids of the page rows among a write's inserts. */
function pageIdsOf(
  inserted: readonly { id: string; type: string }[],
): string[] {
  return inserted.filter((r) => r.type === PAGE_BLOCK_TYPE).map((r) => r.id);
}

/** Deleted ids whose parent is not itself being deleted. */
function deleteRootsOf(deleted: DeletedBlockRow[]): string[] {
  const ids = new Set(deleted.map((r) => r.id));
  return deleted
    .filter((r) => r.parentId === null || !ids.has(r.parentId))
    .map((r) => r.id);
}

/**
 * The rows a delete set REALLY removes from a forest: the named ids plus every
 * descendant of theirs in `forest`, in forest order. A hard delete used to get
 * this closure for free from the FK cascade; a trash flags exactly the ids it is
 * handed, so the writer must close the set itself — a descendant left live under
 * a trashed parent is unreachable by any read and unrestorable by any entry.
 *
 * `forest` is the page's forest AS THE WRITE LEAVES IT: every surviving row
 * (inserts included) at its NEW parent, every removed row at its old one. The
 * FK cascade ran after the moves, and a closure over the forest the write READ
 * does not — it counts a child the same write re-parents out of a deleted block
 * as that block's descendant, and trashes it right after its own update.
 *
 * The forest is one page's live partition, so the closure cannot cross into a
 * sub-page's content: a `type="page"` row in it is what defers the whole set to
 * the chokepoint, which walks across page boundaries.
 */
function deleteClosureOf(
  forest: readonly DeletedBlockRow[],
  deleteIds: ReadonlySet<string>,
): DeletedBlockRow[] {
  const childrenOf = new Map<string, DeletedBlockRow[]>();
  for (const row of forest) {
    if (row.parentId === null) continue;
    const list = childrenOf.get(row.parentId);
    if (list) list.push(row);
    else childrenOf.set(row.parentId, [row]);
  }
  const removed = new Set<string>();
  const stack = forest.filter((r) => deleteIds.has(r.id)).map((r) => r.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (removed.has(id)) continue;
    removed.add(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
  }
  return forest
    .filter((r) => removed.has(r.id))
    .map((r) => ({
      id: r.id,
      type: r.type,
      pageId: r.pageId,
      parentId: r.parentId,
    }));
}

/**
 * Run the `OnDelete` hooks over the AUTHORITATIVE delete set, inside the locked
 * transaction, on exactly the branch that really hard-deletes, exactly once.
 *
 * Hooks receive ROWS (not ids), which is what removed their need to be "before":
 * every contributor wants one fact — *which of these were page rows* — and
 * `row.type` answers it in memory, so the lock is held for zero extra I/O in
 * practice. Anything a hook genuinely must read pre-delete it reads on `ctx.tx`.
 * The returned callbacks are queued on `afterCommit`: re-push work (deindex,
 * version drops, backlink panels) must not hold the lock.
 */
export async function runOnDelete(
  ctx: PageForestCtx,
  rows: DeletedBlockRow[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const hook of BlockLifecycle.OnDelete.getContributions()) {
    const cb = await hook.onDelete(rows, ctx.tx);
    if (cb) ctx.afterCommit(cb);
  }
}

/**
 * Run the `OnTrash` hooks over a set of rows that were just flagged. Always
 * AFTER the trashing transaction commits (queue it on `ctx.afterCommit`): the
 * hooks do heavy re-derivation (search deindex, backlink edge deletes) that
 * must not hold the page locks.
 */
export async function runOnTrash(
  rows: readonly DeletedBlockRow[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const hook of BlockLifecycle.OnTrash.getContributions()) {
    await hook.onTrash(rows);
  }
}

/** The `OnRestore` twin of {@link runOnTrash}: after the restoring commit. */
export async function runOnRestore(
  rows: readonly DeletedBlockRow[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const hook of BlockLifecycle.OnRestore.getContributions()) {
    await hook.onRestore(rows);
  }
}

/** What a ledger entry is minted from — the arguments of `recordTrashEntry`. */
export interface TrashEntryArgs {
  sourceId: string;
  rootEntityId: string;
  label: string;
  meta: Record<string, unknown>;
}

/** The longest label a `page-blocks` entry carries; longer text is cut. */
const BLOCK_ENTRY_LABEL_MAX = 80;

/**
 * The ONE spelling of a `page-blocks` ledger entry — the anchor entry a delete
 * with no page root mints for its content rows. Shared by both write shapes
 * and by the chokepoint, so an entry cannot be labelled three ways:
 *
 *  - `rootEntityId` = the first delete root;
 *  - `label` = the first non-empty line of that root's text, cut to
 *    {@link BLOCK_ENTRY_LABEL_MAX}, else `"N blocks"` (a void block, or an
 *    empty one);
 *  - `meta` = `{ pageId, rootIds, count }`, so a future "Deleted blocks" UI can
 *    say where the rows came from without re-walking anything.
 */
export function pageBlocksTrashEntry(args: {
  pageId: string | null;
  /** The delete roots, first one first, with their stored `data`. */
  roots: readonly { id: string; data: unknown }[];
  /** Every row the operation trashes (roots + descendants). */
  count: number;
}): TrashEntryArgs {
  const first = args.roots[0];
  if (first === undefined) {
    throw new Error(
      "pageBlocksTrashEntry: a trash entry needs at least one root",
    );
  }
  const firstLine =
    textOf(first)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const label =
    firstLine.length === 0
      ? `${args.count} block${args.count === 1 ? "" : "s"}`
      : firstLine.length > BLOCK_ENTRY_LABEL_MAX
        ? `${firstLine.slice(0, BLOCK_ENTRY_LABEL_MAX - 1)}…`
        : firstLine;
  return {
    sourceId: PAGE_BLOCKS_TRASH_SOURCE,
    rootEntityId: first.id,
    label,
    meta: {
      pageId: args.pageId,
      rootIds: args.roots.map((r) => r.id),
      count: args.count,
    },
  };
}

/**
 * Trash a delete set INLINE, inside the caller's locked transaction: record ONE
 * ledger entry, flag every row under it, and queue the `OnTrash` hooks for
 * after commit. Returns the entry id — the caller's undo handle.
 *
 * The ledger insert and the flag UPDATE share `ctx.tx`, which is what makes the
 * ledger invariant ("an entry exists ⇔ at least one row carries its id") hold
 * by construction on the trash side; `untrashBlocks` holds it on the restore
 * side by deleting the entry in the same transaction that clears the flags.
 * `rows` must be non-empty — an entry with no rows would violate it.
 */
export async function trashDeletedRows(
  ctx: PageForestCtx,
  rows: readonly DeletedBlockRow[],
  entry: TrashEntryArgs,
): Promise<string> {
  if (rows.length === 0) {
    throw new Error(
      "trashDeletedRows: refusing to mint a ledger entry with no rows",
    );
  }
  const entryId = await recordTrashEntry(ctx.tx, entry);
  await trashBlockRoots(
    ctx.tx,
    rows.map((r) => r.id),
    entryId,
  );
  ctx.afterCommit(() => runOnTrash(rows));
  return entryId;
}

/**
 * The delete branch both write shapes share, and it runs FIRST — before any
 * rank is parked or any row placed (see {@link ForestWriteResult} for why).
 * Closes `deleteIds` over the as-written forest; a page-free set is then
 * trashed inline under one `page-blocks` entry, a page-containing one is left
 * for the caller's chokepoint.
 *
 * The entry's label reads the roots' PRE-write rows (`snapshot`). Every root is
 * an id the write named for deletion, and a named row is never also written, so
 * each one has exactly one row to read.
 */
async function trashBeforePlacing(
  ctx: PageForestCtx,
  args: {
    /** The page's forest as the write will leave it — see {@link deleteClosureOf}. */
    asWritten: readonly DeletedBlockRow[];
    deleteIds: ReadonlySet<string>;
    snapshot: ReadonlyMap<
      string,
      { id: string; pageId: string | null; data: unknown }
    >;
  },
): Promise<Omit<ForestWriteResult, "createdPageIds" | "claimedFromPageIds">> {
  const deletedRows = deleteClosureOf(args.asWritten, args.deleteIds);
  const deleteRootIds = deleteRootsOf(deletedRows);
  const deferredToChokepoint = deletedRows.some(
    (r) => r.type === PAGE_BLOCK_TYPE,
  );

  let trashedEntryId: string | null = null;
  if (!deferredToChokepoint && deletedRows.length > 0) {
    const roots = deleteRootIds.map((id) => args.snapshot.get(id)!);
    trashedEntryId = await trashDeletedRows(
      ctx,
      deletedRows,
      pageBlocksTrashEntry({
        pageId: roots[0]!.pageId,
        roots,
        count: deletedRows.length,
      }),
    );
  }

  return { deletedRows, deleteRootIds, deferredToChokepoint, trashedEntryId };
}

/**
 * Flag the INSERTS an inline trash's closure reached — rows a buggy reducer or
 * patch placed under a row this same write removes. They did not exist yet when
 * {@link trashBeforePlacing} flagged the set, so they join its entry here, in
 * the same transaction, the moment they do. Nothing correct produces one; the
 * alternative is a live row under a trashed parent, unreachable by any read. A
 * deferred set needs nothing: the chokepoint walks the stored forest after
 * commit, by which time it holds them.
 */
async function trashOrphanInserts(
  tx: PageForestTx,
  write: Pick<ForestWriteResult, "trashedEntryId" | "deletedRows">,
  insertedIds: readonly string[],
): Promise<void> {
  if (write.trashedEntryId === null) return;
  const trashed = new Set(write.deletedRows.map((r) => r.id));
  await trashBlockRoots(
    tx,
    insertedIds.filter((id) => trashed.has(id)),
    write.trashedEntryId,
  );
}

// ---------------------------------------------------------------------------
// Write shape 1 — the op handler's reconcile-and-persist
// ---------------------------------------------------------------------------

/**
 * Reconcile `before` → `after`, then persist the diff: trash the delete set,
 * park, insert, update.
 *
 * The op reducers cannot cross a page boundary (the reparenting ops are refused
 * an out-of-page destination at the handler), so surviving nodes keep their
 * `pageId` and new nodes inherit it from their parent/sibling.
 *
 * **Rank parking is unconditional**, not per-op. `page_blocks` carries a
 * non-deferrable `(parent_id, rank)` unique index, so ANY batch that permutes
 * ranks among siblings transiently duplicates a pair mid-loop — a `bulkMove`
 * mints its window EXCLUDING the movers, so a computed key routinely equals a
 * rank a still-unmoved root holds. Two reducer arms still mint strictly above
 * the vacating row's own rank (`applyMerge`'s adoption, `applyUnwrap`'s
 * promotion), which once was what kept them off the rank of a row that stayed
 * live until the end of the write; trashing first and parking make the write
 * shape correct for every arm, present and future, instead of asking each one
 * to re-derive the collision argument. `pairChanged` filters parking to rows
 * that really move, so the ops that permute nothing (a split, a text patch) pay
 * for no extra statement at all.
 */
export async function writeForestTarget(
  ctx: PageForestCtx,
  before: BlockNode[],
  after: BlockNode[],
  claims: ReadonlyMap<string, PageClaim> = new Map(),
): Promise<ForestWriteResult> {
  const { inserted, updated, deletedIds } = reconcileBlocks(before, after);
  const beforeById = new Map(before.map((n) => [n.id, n]));
  const afterById = new Map(after.map((n) => [n.id, n]));

  // Trash FIRST, closed over the forest as written: every row of `before` at
  // the parent `after` gives it (a removed row, absent from `after`, keeps its
  // own), plus the inserts. A reducer already removes a subtree whole, so the
  // closure adds nothing for it — it is the guarantee, not the common path.
  // A page-free set is flagged here, vacating its `(parent_id, rank)` slots for
  // the placements below; `parkRanks`' floor still counts the flagged ranks,
  // which is harmless — a park key only has to sit above it. A page-containing
  // set stays live for the caller's chokepoint (its residual is stated on
  // `ForestWriteResult`).
  const write = await trashBeforePlacing(ctx, {
    asWritten: [...before.map((n) => afterById.get(n.id) ?? n), ...inserted],
    deleteIds: new Set(deletedIds),
    snapshot: beforeById,
  });

  // Vacate every `(parent_id, rank)` pair this diff reassigns before any final
  // key lands, so the per-tuple unique index cannot fire on a transient
  // duplicate. Ordered before the inserts for `writeBlockPatch`'s reason: they
  // may take a pair a re-ranked row is moving off.
  await parkRanks(ctx.tx, {
    placements: updated.flatMap(({ id, node }) => {
      const prev = beforeById.get(id)!;
      if (!pairChanged(prev, node)) return [];
      return [
        {
          id,
          currentParentId: prev.parentId,
          parentId: node.parentId,
          rank: node.rank,
        },
      ];
    }),
    incoming: inserted.map((node) => ({
      parentId: node.parentId,
      rank: node.rank,
    })),
  });

  const now = new Date();
  // Parent-before-descendant, so the self-FK holds row by row: a claimed page may
  // sit under a container this same paste inserts. Consecutive inserts still go
  // out as one statement.
  let batch: NewBlockRow[] = [];
  for (const node of inserted) {
    const claim = claims.get(node.id);
    if (claim === undefined) {
      batch.push({
        id: node.id,
        // In-page ops never change pageId; new nodes carry the pageId the
        // reducer already inherited from their parent/sibling.
        pageId: node.pageId,
        parentId: node.parentId,
        type: node.type,
        data: parseBlockData(node.type, node.data),
        rank: node.rank,
        expanded: node.expanded,
        createdAt: now,
      });
      continue;
    }
    await insertBlocks(ctx.tx, batch);
    batch = [];
    await placeClaimedPage(ctx, node, claim);
  }
  await insertBlocks(ctx.tx, batch);
  await trashOrphanInserts(
    ctx.tx,
    write,
    inserted.map((node) => node.id),
  );

  for (const { id, node } of updated) {
    await updateBlockFields(ctx.tx, id, {
      parentId: node.parentId,
      type: node.type,
      // The reducer's output restates every column of a changed row, `data`
      // included, so it is judged against the row it replaces.
      data: rewriteBlockData({
        type: node.type,
        before: beforeById.get(id)!,
        next: node.data,
      }),
      rank: node.rank,
      expanded: node.expanded,
    });
  }

  return {
    ...write,
    createdPageIds: pageIdsOf(inserted.filter((n) => !claims.has(n.id))),
    claimedFromPageIds: inserted.flatMap((n) => {
      const from = claims.get(n.id)?.pageId;
      return from === undefined || from === null ? [] : [from];
    }),
  };
}

/**
 * Place a claimed page where the reducer planned it: one UPDATE moves the stored
 * row (and clears its trash flags, when the cut trashed it) — its `data` is left
 * alone, so the page keeps its own title, icon and author rather than the
 * clipboard's copy of them. Its content needs no re-scoping: it is keyed
 * `page_id = <its id>`, which a move does not change.
 *
 * A trashed claim then takes back the rest of its subtree from the cut's entry —
 * only the rows under THIS page: a cut of `[paragraph, page]` flags both under
 * one entry, and the paragraph (pasted as a fresh copy) stays in the trash. Rows
 * under the page that an earlier, separate delete trashed keep their own entry.
 * The entry is consumed once no row carries it. The `OnRestore` hooks run after
 * commit over every row that came back, exactly as for a restore.
 */
async function placeClaimedPage(
  ctx: PageForestCtx,
  node: BlockNode,
  claim: PageClaim,
): Promise<void> {
  await updateBlockFields(ctx.tx, node.id, {
    parentId: node.parentId,
    pageId: node.pageId,
    rank: node.rank,
    expanded: node.expanded,
    deletedAt: null,
    trashEntryId: null,
  });
  const entryId = claim.trashEntryId;
  if (entryId === null) return;

  const subtree = await executeRows(ctx.tx, {
    label: "page_blocks claimed page subtree",
    query: sql`
      WITH RECURSIVE sub AS (
        SELECT id FROM page_blocks
         WHERE parent_id = ${node.id} AND trash_entry_id = ${entryId}
        UNION
        SELECT b.id FROM page_blocks b JOIN sub s ON b.parent_id = s.id
         WHERE b.trash_entry_id = ${entryId}
      )
      SELECT b.id, b.type, b.page_id, b.parent_id
        FROM page_blocks b JOIN sub USING (id)
    `,
    row: z.object({
      id: z.string(),
      type: z.string(),
      page_id: z.string().nullable(),
      parent_id: z.string().nullable(),
    }),
  });
  await untrashBlockRoots(
    ctx.tx,
    subtree.map((r) => r.id),
  );
  const [remaining] = await ctx.tx
    .select({ id: _blocks.id })
    .from(_blocks)
    .where(eq(_blocks.trashEntryId, entryId))
    .limit(1);
  if (remaining === undefined) {
    await ctx.tx
      .delete(_trashEntries)
      .where(eq(_trashEntries.id, trashEntryIdKind.key(entryId)));
  }

  const restored: DeletedBlockRow[] = [
    {
      id: node.id,
      type: node.type,
      pageId: node.pageId,
      parentId: node.parentId,
    },
    ...subtree.map((r) => ({
      id: r.id,
      type: r.type,
      pageId: r.page_id,
      parentId: r.parent_id,
    })),
  ];
  ctx.afterCommit(() => runOnRestore(restored));
}

// ---------------------------------------------------------------------------
// Write shape 2 — the patch handler's field-scoped write
// ---------------------------------------------------------------------------

/**
 * A `BlockPatch` resolved against the LOCKED forest: which creates are fresh
 * inserts, which re-assert a live row, and which updates/deletes survived the
 * "an update never creates" rule.
 *
 * Resolution is the handler's policy — it owns the un-trash prelude (a create
 * whose id is TRASHED restores its whole ledger entry BEFORE this write, and
 * is then excluded from every bucket here), the page-type transition guard and
 * the notify heuristic. This is the write. There is deliberately no "un-trash"
 * bucket: clearing a row's flags without consuming its ledger entry would leave
 * an entry that points at nothing, which the ledger invariant forbids.
 */
export interface ResolvedBlockPatch {
  /** Rows that do not exist yet. */
  inserts: Block[];
  /** Full-row re-asserts onto rows that are already live (a replayed undo). */
  overwrites: Block[];
  /** Field-scoped updates; ids are guaranteed live. */
  updates: { id: string; changes: BlockFieldChanges }[];
  /** The LOCKED page forest (every live row), keyed by id. */
  stored: Map<string, BlockRow>;
  /**
   * The ids this patch removes. Ids not in `stored` are skipped (already gone);
   * the writer closes the set under descendants itself. Disjoint from every
   * write bucket — the handler refuses a patch that names one id as both (400),
   * because the delete is flagged first and the write would then land on a row
   * it has just trashed.
   */
  deleteIds: readonly string[];
}

/**
 * Every column of a full row — what a create asserts. Written over a row that
 * is already live, so its `data` is a rewrite of `before`'s and is judged as one.
 */
function fullRow(b: Block, before: BlockRow): BlockColumnChanges {
  return {
    pageId: b.pageId,
    parentId: b.parentId,
    type: b.type,
    data: rewriteBlockData({ type: b.type, before, next: b.data }),
    rank: b.rank.toJSON(),
    expanded: b.expanded,
  };
}

/**
 * The patch handler's whole write: trash the delete set, park the `(parent_id,
 * rank)` pairs this batch reassigns, then write the columns each entry NAMES.
 *
 * Field-scoped is the invariant, not an implementation detail. A writer that
 * owns one field cannot restate — and therefore cannot clobber — a field a
 * concurrent writer owns: the `data.text` projection says `data` and nothing
 * else, so it can no longer push a stale `type` over a conversion the user just
 * made. Only `creates` assert whole rows, because a create IS the full state.
 */
export async function writeBlockPatch(
  ctx: PageForestCtx,
  patch: ResolvedBlockPatch,
): Promise<ForestWriteResult> {
  const { inserts, overwrites, updates, stored } = patch;
  const deleteIds = new Set(patch.deleteIds);
  for (const id of [
    ...inserts.map((b) => b.id),
    ...overwrites.map((b) => b.id),
    ...updates.map((u) => u.id),
  ]) {
    if (deleteIds.has(id)) {
      throw new Error(
        `writeBlockPatch: block ${id} is both written and deleted — the patch handler refuses that shape before it reaches the writer`,
      );
    }
  }

  // Trash FIRST — the same branch, for the same reasons, as `writeForestTarget`
  // — closed over the forest as this patch leaves it: each update at the parent
  // it NAMES (one that names none stays put), each overwrite at its full row,
  // plus the inserts. So the redo of an `unwrap` (the children re-parented up,
  // the container deleted) keeps the children.
  const overwriteById = new Map(overwrites.map((b) => [b.id, b]));
  const changesById = new Map(updates.map((u) => [u.id, u.changes]));
  const write = await trashBeforePlacing(ctx, {
    asWritten: [
      ...[...stored.values()].map((row): DeletedBlockRow => {
        const overwrite = overwriteById.get(row.id);
        if (overwrite) return overwrite;
        const changes = changesById.get(row.id);
        return changes && namesField(changes, "parentId")
          ? { ...row, parentId: changes.parentId! }
          : row;
      }),
      ...inserts,
    ],
    deleteIds,
    snapshot: stored,
  });

  // Rows whose `(parentId, rank)` pair moves must be parked before the final
  // writes land — see `parkRanks`. This is a blind writer: undoing a swap hands
  // two rows each other's ranks, which the per-tuple `(parent_id, rank)` unique
  // index would reject mid-loop. A write that names NEITHER `parentId` nor
  // `rank` leaves the pair where it is, so it needs no park at all.
  const placements = [
    ...updates.map((u) => ({ id: u.id, changes: u.changes })),
    // A create asserts the whole row, so it always names both halves of the pair.
    ...overwrites.map((b) => ({
      id: b.id,
      changes: {
        parentId: b.parentId,
        rank: b.rank,
      } satisfies BlockFieldChanges,
    })),
  ].flatMap(({ id, changes }) => {
    const before = stored.get(id)!;
    const next = {
      parentId: namesField(changes, "parentId")
        ? changes.parentId!
        : before.parentId,
      rank: namesField(changes, "rank") ? changes.rank!.toJSON() : before.rank,
    };
    if (!pairChanged(before, next)) return [];
    return [{ id, currentParentId: before.parentId, ...next }];
  });
  const incoming = inserts.map((b) => ({
    parentId: b.parentId,
    rank: b.rank.toJSON(),
  }));

  // Parking runs before the inserts so they can take a pair a re-ranked row is
  // moving off. It only bumps `rank`, never `parent_id`, so it cannot depend on
  // a row `inserts` has not created yet.
  await parkRanks(ctx.tx, { placements, incoming });

  const now = new Date();
  await insertBlocks(
    ctx.tx,
    inserts.map((b) => ({
      id: b.id,
      pageId: b.pageId,
      parentId: b.parentId,
      type: b.type,
      data: parseBlockData(b.type, b.data),
      rank: b.rank.toJSON(),
      expanded: b.expanded,
      createdAt: now,
    })),
  );
  await trashOrphanInserts(
    ctx.tx,
    write,
    inserts.map((b) => b.id),
  );

  for (const b of overwrites) {
    await updateBlockFields(ctx.tx, b.id, fullRow(b, stored.get(b.id)!));
  }

  // A parked row sits at a scratch rank until its final pair is written, so
  // phase 2 writes BOTH halves of that pair from the placement — never only the
  // halves the update names. An update naming just `parentId` (a move whose rank
  // string is still free under the new parent) would otherwise land at its park
  // key: out of order at best, and onto a sibling's final rank at worst.
  const parked = new Map(placements.map((p) => [p.id, p] as const));
  for (const u of updates) {
    const before = stored.get(u.id)!;
    const changes = u.changes;
    const placement = parked.get(u.id);
    // ONLY the named columns. `rewriteBlockData` validates against the EFFECTIVE
    // type, which is the point of the two-way split below:
    //  - `data` named → validate it against the type this write leaves the row
    //    at (the new one when `type` is also named, else the STORED one) — and,
    //    when the type is kept, refuse a payload that changes the row's author;
    //  - `type` named alone → the stored blob's validity is now judged by a
    //    different schema, so re-validate (and re-mint) it against the new type.
    //    A blob the target type rejects is a loud 400 here rather than an
    //    unreadable row later.
    const type = namesField(changes, "type") ? changes.type! : before.type;
    const set: BlockColumnChanges = {};
    if (placement) {
      set.parentId = placement.parentId;
      set.rank = placement.rank;
    }
    if (namesField(changes, "expanded")) set.expanded = changes.expanded!;
    if (namesField(changes, "type")) set.type = changes.type!;
    if (namesField(changes, "data"))
      set.data = rewriteBlockData({ type, before, next: changes.data });
    else if (namesField(changes, "type"))
      set.data = rewriteBlockData({ type, before, next: before.data });
    await updateBlockFields(ctx.tx, u.id, set);
  }

  return {
    ...write,
    createdPageIds: pageIdsOf(inserts),
    claimedFromPageIds: [],
  };
}
