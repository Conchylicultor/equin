import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  aggregate,
  childrenJoin,
  type ColumnRef,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { materializeJoin } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { PAGE_BLOCK_TYPE } from "../../core";
import { _pageContentEditedAt, _pageTreeChildren } from "./rollup-table";
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
 * Every rollup this plugin contributes (`DerivedTable`, server/index.ts) — the
 * one list the boot contributions and the suites installing the derived layer
 * read, so a new one cannot be missed by either.
 */
export const PAGE_ROLLUPS = [
  pageContent.rollup,
  pageTreeChildren.rollup,
] as const;
