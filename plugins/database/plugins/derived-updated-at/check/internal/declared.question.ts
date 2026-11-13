// The `derived-updated-at:declared` question, asked of each schema file in the
// schema question host (`askSchemaFiles`): the drizzle `PgTable`s the file
// exports — exactly the set drizzle-kit migrates — that have a column
// physically named `updated_at` and whose table registered no derived-updatedAt
// declaration (`defineEntity`'s `meta.updatedAt` or `deriveUpdatedAt`) while
// the schema files loaded.
//
// The registry is imported through the SAME specifier the schema files use, so
// the host holds one module instance of it and sees their registrations.
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { SchemaQuestion } from "@plugins/database/plugins/migrations/plugins/schema-question/core";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";

/** The tables of one file with an undeclared `updated_at`. */
export type DeclaredAnswer = string[];

export default {
  answer(_file, exports) {
    const declared = new Set(registeredDerivedUpdatedAt().map((s) => s.table));
    const undeclared: string[] = [];
    for (const value of Object.values(exports)) {
      if (!is(value, PgTable)) continue;
      const hasUpdatedAt = Object.values(getTableColumns(value)).some(
        (col) => col.name === "updated_at",
      );
      const table = getTableName(value);
      if (hasUpdatedAt && !declared.has(table)) undeclared.push(table);
    }
    return undeclared;
  },
} satisfies SchemaQuestion<DeclaredAnswer>;
