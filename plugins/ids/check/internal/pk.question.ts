// The `ids:pk-declared` question, asked of each schema file in the schema
// question host (`askSchemaFiles`): the drizzle `PgTable`s the file exports —
// exactly the set drizzle-kit migrates — keyed by a single column named `id`
// whose column is not a declared id: `idColumn(kind)` / a `defineEntity`
// record's `idKindField(kind)` (its decoder is a kind's stored-id schema) or
// `externalIdColumn`. Read off the BUILT column, so a table counts however it
// was spelled, and wherever its field record lives.
//
// `idColumnDeclaration` is imported through the SAME specifier the schema
// files use, so the host holds one module instance of its registries.
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type { SchemaQuestion } from "@plugins/database/plugins/migrations/plugins/schema-question/core";
import { idColumnDeclaration } from "@plugins/ids/server";

/** The tables of one file whose `id` primary key names no id kind. */
export type PkAnswer = string[];

export default {
  answer(_file, exports) {
    const undeclared: string[] = [];
    for (const value of Object.values(exports)) {
      if (!is(value, PgTable)) continue;
      // A composite `primaryKey({ columns })` is not a single-column id.
      if (getTableConfig(value).primaryKeys.length > 0) continue;
      const id = Object.values(getTableColumns(value)).find(
        (col) => col.primary && col.name === "id",
      );
      if (!id || idColumnDeclaration(id).kind !== "undeclared") continue;
      undeclared.push(getTableName(value));
    }
    return undeclared;
  },
} satisfies SchemaQuestion<PkAnswer>;
