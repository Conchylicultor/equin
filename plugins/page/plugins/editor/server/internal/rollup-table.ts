import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  PAGE_CONTENT_EDITED_AT_TABLE,
  PAGE_TREE_CHILDREN_TABLE,
  PAGE_LIVE_TABLE,
  PAGE_TREE_RANK_TABLE,
} from "@plugins/database/plugins/derived-views/core";

// Drizzle READ handles for the page rows' two materialized joins
// (`./rollup-spec.ts`, query-resource's `materializeJoin`): one row per page
// with a group, keyed by the page id, one column per aggregate by property
// name — asserted against the aggregates at module eval.
//
//  - `page_content_edited_at`: the newest `updated_at` over the page's live
//    content blocks. Nullable: the aggregate has no `ifNone` (a page with no
//    content has no content edit time — `greatest` skips the NULL).
//  - `page_tree_children`: how many live pages name the page as their nearest
//    page ancestor — every `pagesTree` row's `$childCount`. NOT NULL: the
//    count reads 0 for a page with none (its `ifNone`).
//
// And the live pages (`./rollup-spec.ts`'s `pageLive`, a plain rollup):
//
//  - `page_live`: one row per live page (`livePageSql`), `live` a constant
//    `true` marker — a missing row reads NULL, "not a live page" — so a
//    materialized join nesting it filters on `live`.
//  - `page_tree_rank`: one row per live block holding a `doc_rank` (a page,
//    a link-to-page block), keyed by the block id — so a materialized join
//    over rows naming a block (`page_links.source_block_id`) reads where it
//    sits in its page's sidebar group.
//
// These live in a NON-glob file (NOT `tables.ts`/`schema.ts`) so the drizzle
// codegen glob (`**/internal/{schema,tables}{,-*}.ts`) never sees them: the
// tables are DERIVED state, created imperatively on boot by
// `rebuildDerivedTables` (via the `DerivedTable` contributions), NOT tracked in
// the migration chain. If a migration is ever generated for one, it was put in
// a glob file by mistake.
//
// Each call stays on one line with its name constant: the
// `table-defs-in-schema-glob` check reads that line to exempt the handle.
export const _pageContentEditedAt = pgTable(PAGE_CONTENT_EDITED_AT_TABLE, {
  pageId: text("page_id").primaryKey(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
});

export const _pageTreeChildren = pgTable(PAGE_TREE_CHILDREN_TABLE, {
  pageId: text("page_id").primaryKey(),
  count: integer("count").notNull(),
});

export const _pageLive = pgTable(PAGE_LIVE_TABLE, {
  pageId: text("page_id").primaryKey(),
  live: boolean("live").notNull(),
});

export const _pageTreeRank = pgTable(PAGE_TREE_RANK_TABLE, {
  blockId: text("block_id").primaryKey(),
  docRank: text("doc_rank").notNull(),
});
