import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import {
  aggregate,
  childrenJoin,
  type ColumnRef,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { materializeJoin } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { PAGE_BLOCK_TYPE } from "../../core";
import {
  _pageContentEditedAt,
  _pageLive,
  _pageTreeChildren,
  _pageTreeRank,
} from "./rollup-table";
import { _blocks } from "./tables";

// The page rows' two MATERIALIZED joins (query-resource's `materializeJoin`):
// each a children join of `page_blocks` over its own rows by `page_id` (the
// nearest page ancestor), stored as a derived-tables rollup keyed by the page
// id and ON the change feed — so the `pagesTree` window reads, filters and
// sorts their aggregates as plain columns, and a reader hears of a page
// exactly when a stored value changed. Every piece of SQL — the table, the
// maintain functions and triggers, the reconcile — is generated from these
// declarations (derived-tables, query-resource CLAUDE.md "Materialized
// aggregate joins").
//
// The join is self-referencing (`page_blocks` counting its own rows by
// `page_id`), so a block moving between pages re-aggregates both (the change
// feed carries old ∪ new `page_id`). Cost per write: one aggregate over that
// page's blocks (`page_blocks_page_id_idx`) and a guarded upsert of one row —
// bounded by the page, never by the forest.

/**
 * Per page P, the newest `updated_at` over P's live CONTENT — every live block
 * whose nearest page is P, sub-page rows included. The page row's own
 * `updated_at` is NOT rolled up (the reader holds it), so a page's edit time
 * is `greatest(row.updated_at, content.editedAt)` — `pageEditedAtSql`
 * (`./page-rows.ts`), the one spelling. A write that moves neither
 * `updated_at` nor `deleted_at` (a `doc_rank` re-mint, a fold toggle —
 * `updated_at` is derived and ignores both) re-aggregates nothing.
 */
export const pageContent = materializeJoin(
  childrenJoin({
    alias: "content",
    table: _blocks,
    fk: _blocks.pageId,
    where: (c) => sql`${c.content.deletedAt} IS NULL`,
    aggregates: (c) => ({
      editedAt: aggregate(sql`max(${c.content.updatedAt})`, {
        decoder: _pageContentEditedAt.editedAt,
        sqlType: "timestamp with time zone",
      }),
    }),
  }),
  { host: _blocks, table: _pageContentEditedAt },
);

/**
 * A live page row: a `type = 'page'` block that is not trashed — the ONE
 * spelling of `pagesTree`'s membership, read by its served `where`
 * (`./page-rows.ts`) and by the child count below, so the count is by
 * construction exactly what an open node's child window reads.
 */
export function livePageSql(
  type: SQLWrapper | ColumnRef,
  deletedAt: SQLWrapper | ColumnRef,
): SQL {
  return sql`(${type} = ${PAGE_BLOCK_TYPE} AND ${deletedAt} IS NULL)`;
}

/** {@link livePageSql} over `page_blocks b`, as the plain SQL text a rollup's `select` is. */
const LIVE_PAGE_ROW = new PgDialect().sqlToQuery(
  livePageSql(sql.raw("b.type"), sql.raw("b.deleted_at")).inlineParams(),
).sql;

/**
 * Per page P, how many LIVE PAGES ({@link livePageSql}) name P as their
 * nearest page ancestor — the tree's `$childCount` (network/live `tree`).
 */
export const pageTreeChildren = materializeJoin(
  childrenJoin({
    alias: "kids",
    table: _blocks,
    fk: _blocks.pageId,
    where: (c) => livePageSql(c.kids.type, c.kids.deletedAt),
    aggregates: () => ({
      count: aggregate(sql`count(*)::int`, {
        decoder: Number,
        sqlType: "integer",
        notNull: true,
        ifNone: sql`0`,
      }),
    }),
  }),
  { host: _blocks, table: _pageTreeChildren },
);

/**
 * The live pages ({@link livePageSql}), one row per page that is not trashed,
 * keyed by its id — the liveness a materialized join over ANOTHER table nests
 * (`NestedRollupJoin`, `on` the column naming a page) when what it aggregates
 * must follow its referent's trash and restore: `page_link_targets` keeps an
 * edge only while its target is live, and a trash or restore re-aggregates
 * every page linking there (the nested rollup's `via` hop), with no write to
 * the edges. A plain rollup, not on the change feed: nobody reads it as a
 * collection, only through the joins nesting it, whose triggers fire on its
 * writes — i.e. only when a page's liveness really flipped (a rename, a
 * typing projection or a move writes nothing here: the source reads `type`
 * and `deleted_at` alone).
 */
export const pageLive = defineRollup({
  table: _pageLive,
  key: _pageLive.pageId,
  select: (scope) => `
    SELECT b.id AS page_id, true AS live
      FROM page_blocks b
     WHERE ${LIVE_PAGE_ROW} AND ${scope("b.id")}`,
  sources: [
    {
      table: _blocks,
      carry: _blocks.id,
      reads: [_blocks.type, _blocks.deletedAt],
    },
  ],
});

/**
 * Where each live page-tree row sits in its sidebar group: one row per live
 * block holding a `doc_rank` (a page, or a type declaring `pageTreePlace` —
 * a link-to-page block), keyed by the block id. What a materialized join
 * over rows that NAME a block nests (`NestedRollupJoin`, `on` the column
 * naming it): `page_link_targets` reads its linking block's rank, so the
 * sidebar draws a link alias where the link is written. A plain rollup, not on
 * the change feed: only the joins nesting it read it, and they hear of a
 * re-mint, a trash or a restore of the block through its writes (a typing
 * projection, a rename or a fold writes nothing here: the source reads
 * `doc_rank` and `deleted_at` alone).
 */
export const pageTreeRank = defineRollup({
  table: _pageTreeRank,
  key: _pageTreeRank.blockId,
  select: (scope) => `
    SELECT b.id AS block_id, b.doc_rank::text AS doc_rank
      FROM page_blocks b
     WHERE b.doc_rank IS NOT NULL AND b.deleted_at IS NULL
       AND ${scope("b.id")}`,
  sources: [
    {
      table: _blocks,
      carry: _blocks.id,
      reads: [_blocks.docRank, _blocks.deletedAt],
    },
  ],
});

/**
 * Every rollup this plugin contributes (`DerivedTable`, server/index.ts) — the
 * one list the boot contributions and the suites installing the derived layer
 * read, so a new one cannot be missed by either.
 */
export const PAGE_ROLLUPS = [
  pageContent.rollup,
  pageTreeChildren.rollup,
  pageLive,
  pageTreeRank,
] as const;
