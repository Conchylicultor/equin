import {
  type AnyPgColumn,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { rankField } from "@plugins/fields/plugins/rank/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import {
  asBlockData,
  pagesEntityRef,
} from "@plugins/page/plugins/block-entity/core";

// One uniform tree of blocks. A "page" is just a block of `type="page"` whose
// payload (`{ title, icon }`) lives in `data` like every other block type —
// there is no separate page table. `parentId` is the single adjacency list
// (pages and content share it); root pages have `parentId = null`.
//
// `pageId` is the denormalized nearest `type="page"` ancestor (maintained on
// insert + reparent via computePageId / recomputePageIdSubtree). It scopes a
// page's content cheaply and partitions the blocks live resource. It is a
// nullable self-FK: a page row at the tree root has `pageId = null`.
//
// `updatedAt` is DERIVED (derived-updated-at): it moves when the block's
// content or placement changes — parent, type, payload, rank, trash flag —
// never on a fold toggle (`expanded`), an `icon` change inside the payload
// (presentation, like the fold: an auto-generated or picked emoji is not an
// edit, and must not reorder Recent pages — the callout's own `icon` key is
// presentation too), a `pageId` recompute or a `docRank` re-mint (functions of
// a placement that already counted), or the trash ledger correlation. No write site stamps it;
// the trigger RAISEs on one that tries.
//
// Built from `pagesEntityRef` (page/block-entity), whose record states every
// column a list may read; the three below are server-only. `data` decodes
// through the record's `StoredBlockDataSchema`: its type is the branded
// `BlockData`, so every write must come from `parseBlockData()` (the sole
// write-side minting site) — an unvalidated `data` is a compile error, not a
// convention. Reads are unaffected (`BlockData` is assignable to the `unknown`
// readers accept).
const blocksEntity = defineEntity(
  pagesEntityRef,
  {
    // The page row's place in its SIDEBAR group — the live page rows sharing
    // its `page_id`, which span several `(parent_id, rank)` spaces, so `rank`
    // cannot order them. WRITER-DERIVED, never authored: `withPageForest`
    // re-mints it for every partition a structural write touched
    // (`doc-rank.ts`), so ordering by it equals document order. NULL on
    // content rows; never in a request body. `pagesTree` carries it as its own
    // (non-null) wire field.
    docRank: nullable(rankField()),
    // NULL = live. A soft delete (trash) sets `deletedAt` + `trashEntryId`
    // instead of DELETEing the row, so the self-referential FK cascades never
    // fire — descendants, `page_block_docs` CRDT text, ext side-tables, and
    // version history all survive until purge. `trashEntryId` correlates the
    // flagged subtree to its `trash_entries` ledger row for exact-restore. The
    // two are ONE flag spelled twice — see the CHECK below.
    deletedAt: nullable(dateField()),
    trashEntryId: nullable(textField()),
  },
  {
    primaryKey: "id",
    columns: {
      pageId: {
        references: {
          column: (): AnyPgColumn => blocksEntity.table.id,
          onDelete: "cascade",
        },
      },
      parentId: {
        references: {
          column: (): AnyPgColumn => blocksEntity.table.id,
          onDelete: "cascade",
        },
      },
      data: { default: asBlockData({}) },
      expanded: { default: true },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    updatedAt: {
      touchedBy: {
        parentId: true,
        type: true,
        data: { exceptKeys: ["icon"] },
        rank: true,
        deletedAt: true,
        // A re-mint follows a placement that already counted (or none at all, for
        // a sibling the reconcile merely re-spaced) — it must not reorder Recent.
        docRank: false,
        id: false,
        pageId: false,
        expanded: false,
        trashEntryId: false,
        createdAt: false,
      },
    },
    indexes: (t) => [
      index("page_blocks_page_parent_rank_idx").on(
        t.pageId,
        t.parentId,
        t.rank,
      ),
      index("page_blocks_page_id_idx").on(t.pageId),
      // Siblings order by `rank`, so two of them sharing one is not a near-miss —
      // it is an unordered pair, and `Rank.between(r, r)` throws rather than
      // inventing a key. That crash is how this was found: the sidebar minted a
      // rank over the `type='page'` projection of a `(parent_id, rank)` space it
      // only half sees, and landed on a content block's key.
      //
      // NOT deferrable: drizzle cannot emit `DEFERRABLE`, and hand-written DDL is
      // barred (generated migrations are hash-guarded; data migrations are
      // DML-only). So the check is per-tuple, and any writer that PERMUTES ranks
      // among siblings must vacate the pairs it reassigns before claiming them —
      // see `forest-writer.ts`. A plain swap has no safe update order; only a scratch
      // value does.
      //
      // Two PARTIAL unique indexes, both `WHERE deleted_at IS NULL`, so a TRASHED
      // row keeps its `(parent_id, rank)` without blocking a new live sibling from
      // reclaiming that slot (and restore re-ranks a colliding root — see
      // `trash-blocks.ts`). Split in two because drizzle-orm 0.36.4's index builder
      // has no `nullsNotDistinct`: the `parent_id IS NULL` root-page sibling list
      // shares one NULL parent, so the default NULL-distinct semantics would exempt
      // exactly that list from the guard — the second index constrains `rank` alone
      // over live root rows to close it.
      uniqueIndex("page_blocks_parent_rank_live_uq")
        .on(t.parentId, t.rank)
        .where(sql`deleted_at IS NULL AND parent_id IS NOT NULL`),
      uniqueIndex("page_blocks_root_rank_live_uq")
        .on(t.rank)
        .where(sql`deleted_at IS NULL AND parent_id IS NULL`),
      index("page_blocks_trash_entry_idx").on(t.trashEntryId),
      // A trashed row ALWAYS names its ledger entry, and a live row never does.
      // Half of the ledger invariant "an entry exists ⇔ at least one row carries
      // its id" (the other half is that the flags are set only by
      // `trashBlockRoots` in the same transaction as `recordTrashEntry`, and
      // cleared only by `untrashBlocks`, which deletes its entry in the same
      // transaction — `trash-blocks.ts`). A writer that sets one flag without the
      // other is rejected by Postgres rather than leaving a row that is neither
      // live nor restorable.
      check(
        "page_blocks_trash_flags_agree",
        sql`(deleted_at IS NULL) = (trash_entry_id IS NULL)`,
      ),
    ],
  },
);
export const _blocks = blocksEntity.table;
