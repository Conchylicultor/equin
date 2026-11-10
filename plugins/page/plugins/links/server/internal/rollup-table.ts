import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { PAGE_LINK_TARGETS_TABLE } from "@plugins/database/plugins/derived-views/core";

// The drizzle READ handle for `pageLinkTargets`' materialized join
// (`./link-target-rows.ts`, query-resource's `materializeJoin`): one row per
// page that links to another, keyed by the page id, its distinct targets as a
// `text[]` (NOT NULL: a page linking nowhere reads `[]`, the aggregate's
// `ifNone`), and its placed linking blocks' ranks as a `jsonb` object of
// target → rank (NOT NULL, `{}` when none) — asserted against the aggregates
// at module eval.
//
// In a NON-glob file (NOT `tables.ts` / `schema.ts`) so the drizzle codegen
// glob never sees it: the table is DERIVED state, created imperatively on boot
// by `rebuildDerivedTables` (via the `DerivedTable` contribution), never in the
// migration chain.
//
// The call stays on one line with its name constant: the
// `table-defs-in-schema-glob` check reads that line to exempt the handle.
export const _pageLinkTargets = pgTable(PAGE_LINK_TARGETS_TABLE, {
  pageId: text("page_id").primaryKey(),
  targets: text("targets").array().notNull(),
  ranks: jsonb("ranks").notNull(),
});
