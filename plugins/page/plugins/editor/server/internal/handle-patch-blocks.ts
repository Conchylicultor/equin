import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { patchBlocks } from "../../core/endpoints";
import { namesField, type BlockPatch } from "../../core/block-diff";
import { BlockSchema, PAGE_BLOCK_TYPE, type Block } from "../../core/schemas";
import { _blocks } from "./tables";
import { liveBlocks } from "./live-blocks";
import { withPageForest, type PageScope } from "./page-forest";
import { writeBlockPatch, type ResolvedBlockPatch } from "./forest-writer";
import { notifyStructuralChange } from "./notify-structural-change";
import { restoreEntryById, deleteBlocksSubtree } from "./trash-blocks";

/**
 * Any drizzle handle this write can OPEN its locked transaction on: the global
 * handle (production) or a db-test-fixture's throwaway DB (tests). Same shape,
 * same reason, as `trash-blocks.ts`'s `BlockExecutor`.
 */
type BlockExecutor = NodePgDatabase;

/**
 * Generic minimal-change patch applier (the undo/redo inverse path). Creates the
 * given full rows, applies each update's NAMED fields, and deletes the given
 * ids, all in one locked transaction. Unlike `handleApplyBlockOp` it runs no
 * reducer — the caller has already computed the exact changes (a forward/reverse
 * {@link BlockPatch} derived from a before/after diff), so this is an
 * authoritative row-level writer onto the CURRENT state.
 *
 * Two invariants make it safe to be blind:
 *  - **An update writes only the columns it names.** A writer that owns one
 *    field cannot restate — and therefore cannot clobber — a field a concurrent
 *    writer owns. The `data.text` projection says `data` and nothing else, so it
 *    can no longer push a stale `type` over a conversion the user just made.
 *  - **An update never creates.** A patch whose target row is gone is a skip, by
 *    definition — which is what keeps a debounced projection flush racing a
 *    history restore from resurrecting a deleted block. Only `creates` may bring
 *    a row into existence (or back: an id matching a soft-deleted row restores).
 *
 * Trash symmetry (zero client changes):
 *  - **Un-trash-on-create.** Every delete is a trash, so a create whose id
 *    matches ANY trashed row — a page shell or a content row — restores that
 *    row's WHOLE ledger entry through `restoreEntryById` BEFORE the write
 *    transaction opens: the entry's rows come back with their stored columns
 *    and their surviving content docs, the entry is consumed, and the create is
 *    then excluded from every write bucket (its row is `stored` now, and the
 *    patch's copy must not overwrite what the restore just repaired — a
 *    re-ranked root, a reparented one). Entries are deduped, so an undo of a
 *    bulk delete restores its one entry once. Cmd+Z after any delete thereby
 *    restores the exact rows and docs.
 *  - **Re-trash-on-redo.** A page-free `deleteIds` is trashed inline by the
 *    writer under a fresh `page-blocks` entry; one containing a `type="page"`
 *    root routes back through the chokepoint (a fresh `pages` entry).
 *
 * Exported (not merely the endpoint's body) because it is THE sanctioned forest
 * write: `page-editor/no-adhoc-forest-write` forbids any other plugin touching
 * `_blocks`, so a server-side writer that computes its own `BlockPatch` — today
 * `page/markdown-apply`, which diffs an incoming markdown document against the
 * stored forest — routes through this one path rather than growing a second.
 *
 * `pageId` is a {@link PageScope}: `null` patches the WORKSPACE ROOT — the
 * sibling space of root pages (`page_id IS NULL`) — so a server-side writer
 * minting a root page with its body (a seed) goes through this same path. The
 * HTTP route names a page only.
 */
export async function applyPageBlockPatch(
  pageId: PageScope,
  patch: BlockPatch,
  executor: BlockExecutor = db,
): Promise<{ blocks: Block[]; watermark: string }> {
  // One id may not be both written and deleted. `diffBlocks` never emits that
  // shape, and the writer trashes the delete set BEFORE it writes anything, so
  // the write would land on a row it had just flagged. Refused here, ahead of
  // the un-trash prelude below, which commits a transaction of its own.
  const deleting = new Set(patch.deleteIds);
  const both = new Set(
    [...patch.creates, ...patch.updates]
      .map((w) => w.id)
      .filter((id) => deleting.has(id)),
  );
  if (both.size > 0) {
    throw new HttpError(
      400,
      `A patch cannot both write and delete a block: ${[...both].join(", ")}`,
    );
  }

  // Which of this patch's creates land on a TRASHED row. Resolvable without the
  // page read (a live row is never `deleted_at IS NOT NULL`), which is what lets
  // the restore below run BEFORE the write transaction opens — it is its own
  // locked write via the chokepoint, and nesting one lock inside another would
  // take them out of the sorted order that keeps writers deadlock-free.
  const createIds = patch.creates.map((b) => b.id);
  const trashedRows =
    createIds.length > 0
      ? await executor
          .select({ id: _blocks.id, trashEntryId: _blocks.trashEntryId })
          .from(_blocks)
          .where(
            and(inArray(_blocks.id, createIds), isNotNull(_blocks.deletedAt)),
          )
      : [];

  // --- Un-trash prelude: restore each named entry ONCE, whole ---------------
  const entryIds = new Set<string>();
  for (const r of trashedRows) {
    if (r.trashEntryId === null) {
      // Unreachable under the `page_blocks_trash_flags_agree` CHECK.
      throw new Error(
        `[page-editor] trashed block ${r.id} carries no trash_entry_id`,
      );
    }
    entryIds.add(r.trashEntryId);
  }
  const restoredIds = new Set<string>();
  for (const entryId of entryIds) {
    const { restoredIds: ids } = await restoreEntryById(entryId, executor);
    for (const id of ids) restoredIds.add(id);
  }
  // A restored row keeps what the restore gave it; the patch says nothing more
  // about it. (A create that named a trashed row whose entry restored NOTHING
  // is unreachable: the row carried the entry's id, so it was restored.)
  const creates = patch.creates.filter((b) => !restoredIds.has(b.id));

  const { value, watermark } = await withPageForest(
    pageId,
    async (ctx) => {
      // The forest read is INSIDE the lock. This is a BLIND writer (its values
      // come from the caller, not from this read), so it needs no atomic read of
      // its own — but the op handler does, and without this lock its window
      // would still be open to a patch: a `convertTo` patch committing
      // between an op's read and its write left the op reasserting the pre-convert
      // `type`, which is how a bullet typed immediately after an Enter turned back
      // into a paragraph.
      // The workspace root holds no content set of its own (`ctx.forest()`
      // loads pages' content), so its rows — the root pages — are read here,
      // under the same lock.
      const rows =
        pageId === null
          ? await ctx.tx
              .select()
              .from(liveBlocks)
              .where(isNull(liveBlocks.pageId))
          : await ctx.forest();
      const stored = new Map(rows.map((r) => [r.id, r]));

      const inserts = creates.filter((b) => !stored.has(b.id));
      // A create landing on a row that is ALREADY live: an idempotent re-assert of
      // the whole row (a replayed undo-of-delete whose row came back by another
      // path). A create IS the full state, so write every column — mirroring
      // `applyPatch`, where a GENUINE create likewise wins outright over the
      // base row. (The client's `applyPatch` keeps a present row for a create it
      // knows to be a restore; that arm is exactly the `restoredIds` exclusion
      // above, which never reaches here.)
      const overwrites = creates.filter((b) => stored.has(b.id));

      // An update naming a row that is not live is a skip — see the header.
      const updates = patch.updates.filter((u) => stored.has(u.id));

      // --- Closed-world guard ---------------------------------------------------
      // A patch holds ONE page's lock, so the rows it creates may join exactly
      // two partitions: the locked page's, and that of a page this same patch
      // creates (a markdown apply minting an `<agent-page>` with its body, a
      // pasted sub-page with its content). No lock is needed for the second:
      // nobody else can know an id that does not exist yet. Any other `pageId`
      // names a partition this write does not hold — a row written there would
      // race that page's own writers and escape its content forest's read. Web
      // patches satisfy this already (the composite store routes creates by
      // their own `pageId`); the guard makes it a refusal rather than a hope.
      const createdPages = new Set(
        inserts.filter((b) => b.type === PAGE_BLOCK_TYPE).map((b) => b.id),
      );
      for (const b of [...inserts, ...overwrites]) {
        if (b.pageId === pageId) continue;
        if (b.pageId !== null && createdPages.has(b.pageId)) continue;
        throw new HttpError(
          400,
          `Block ${b.id} is created under page ${b.pageId ?? "null"}, but this patch ` +
            `writes page ${pageId}: a create may join the locked page, or a page the same ` +
            `patch creates, and no other.`,
        );
      }

      // --- Page-type transition guard -----------------------------------------
      // A `page` row owns every row keyed `page_id = <its id>`. Flipping it to a
      // content type would leave that content unreachable by any query, forever;
      // flipping a content row INTO a page would claim no content and leave its
      // existing children mis-scoped (their `page_id` still names the outer page).
      // Neither is expressible as a row-level patch — the only sanctioned in-place
      // transition into `page` is `POST /api/blocks/:id/turn-into-page`, which
      // reparents the descendants' `page_id` in the same transaction. Fail loudly
      // rather than silently orphan. Only writes that NAME `type` can trip it: an
      // update that says nothing about `type` cannot change one.
      const typeWrites: { id: string; from: string; to: string }[] = [
        ...updates.flatMap((u) =>
          namesField(u.changes, "type")
            ? [{ id: u.id, from: stored.get(u.id)!.type, to: u.changes.type! }]
            : [],
        ),
        ...overwrites.map((b) => ({
          id: b.id,
          from: stored.get(b.id)!.type,
          to: b.type,
        })),
      ];
      for (const t of typeWrites) {
        if (t.from === t.to) continue;
        if (t.from === PAGE_BLOCK_TYPE || t.to === PAGE_BLOCK_TYPE) {
          throw new HttpError(
            409,
            `Cannot change block ${t.id} from type "${t.from}" to "${t.to}": ` +
              `a "${PAGE_BLOCK_TYPE}" row scopes its own content by page_id. ` +
              `Use POST /api/blocks/:id/turn-into-page.`,
          );
        }
      }

      const resolved: ResolvedBlockPatch = {
        inserts,
        overwrites,
        updates,
        stored,
        deleteIds: patch.deleteIds,
      };
      const write = await writeBlockPatch(ctx, resolved);

      const didWrite =
        inserts.length > 0 ||
        updates.length > 0 ||
        overwrites.length > 0 ||
        restoredIds.size > 0 ||
        write.deleteRootIds.length > 0;

      return { write, didWrite };
    },
    executor,
  );
  const { write, didWrite } = value;

  // Re-trash a page-containing set (redo of a page delete) via the chokepoint,
  // after the write transaction so its inserts/updates land first.
  if (write.deferredToChokepoint && write.deleteRootIds.length > 0) {
    await deleteBlocksSubtree(write.deleteRootIds, executor);
  }

  if (didWrite) {
    await notifyStructuralChange(
      {
        pageId,
        deletedRows: write.deletedRows,
        createdPageIds: write.createdPageIds,
      },
      executor,
    );
  }

  const finalRows = await executor
    .select()
    .from(liveBlocks)
    .where(
      pageId === null
        ? isNull(liveBlocks.pageId)
        : eq(liveBlocks.pageId, pageId),
    )
    .orderBy(asc(liveBlocks.rank), asc(liveBlocks.createdAt));
  return { blocks: finalRows.map((r) => BlockSchema.parse(r)), watermark };
}

/** The HTTP face of {@link applyPageBlockPatch} — validation and nothing else. */
export const handlePatchBlocks = implement(patchBlocks, ({ params, body }) =>
  applyPageBlockPatch(params.pageId, body),
);
