import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { PAGE_CONTENT_EDITED_AT_TABLE } from "@plugins/database/plugins/derived-views/core";

// Drizzle READ handle for the `page_content_edited_at` rollup — per page, the
// newest `updated_at` over its live content blocks. The `pages.tree` set joins
// it (`./page-rows.ts`) to give every page row its `editedAt`.
//
// This lives in a NON-glob file (NOT `tables.ts`/`schema.ts`) so the drizzle
// codegen glob (`**/internal/{schema,tables}{,-*}.ts`) never sees it: the table
// is DERIVED state, created imperatively on boot by `prepareRollupTables` (via
// the `DerivedTable` contribution / `rollup-spec.ts`), NOT tracked in the
// migration chain. If a migration is ever generated for this table, it was put
// in a glob file by mistake.
//
// The call stays on one line with its name constant: the
// `table-defs-in-schema-glob` check reads that line to exempt the handle.
export const _pageContentEditedAt = pgTable(PAGE_CONTENT_EDITED_AT_TABLE, {
  pageId: text("page_id").primaryKey(),
  editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
});
