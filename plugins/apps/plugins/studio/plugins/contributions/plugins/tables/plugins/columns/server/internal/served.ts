import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { ColumnSchema, tableColumns } from "../../shared/resources";

// `information_schema` identifier columns are `name` (OID 19) and its
// `character_data` columns are `varchar` — both scalar, both decoded as
// strings; `ordinal_position` is `int4`, so it really is a number.
const TableNameRowSchema = z.object({ table_name: z.string() });

async function loadColumns({ tableName }: { tableName: string }) {
  const tableCheck = await executeRows(db, {
    query: sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${tableName}`,
    row: TableNameRowSchema,
    label: "studio table exists (columns)",
  });
  if (tableCheck.length === 0) {
    throw tableColumns.refuse("missing", `Table "${tableName}" not found`);
  }

  // The wire contract IS the row shape here, so the value's own row schema is
  // what parses the read — one definition, no chance of the two drifting.
  const columns = await executeRows(db, {
    query: sql`SELECT column_name, data_type, is_nullable, column_default, ordinal_position FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${tableName} ORDER BY ordinal_position`,
    row: ColumnSchema,
    label: "studio table columns",
  });

  return { columns };
}

// External `fixed`, not `db`: the loader reads only `information_schema`,
// which the change feed cannot see (it triggers `public` tables), so a `db`
// read-set would be empty and never fire. Nothing needs it to: the schema is
// migrated at boot, before any read is served, and no DDL runs mid-process —
// a schema change is a new process. (A `no-db-backed-notify` sanctioned
// exemption in this plugin's exempt/index.ts records the catalog read.)
export const tableColumnsServed = serveValue(tableColumns, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "the public schema is migrated at boot, before any read; no DDL runs mid-process",
    },
  },
  loader: loadColumns,
});
