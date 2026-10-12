import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { IndexSchema, tableIndexes } from "../../shared/resources";

// `information_schema.tables.table_name` is `name` (OID 19) — scalar, decoded
// as a string.
const TableNameRowSchema = z.object({ table_name: z.string() });

async function loadIndexes({ tableName }: { tableName: string }) {
  const tableCheck = await executeRows(db, {
    query: sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${tableName}`,
    row: TableNameRowSchema,
    label: "studio table exists (indexes)",
  });
  if (tableCheck.length === 0) {
    throw tableIndexes.refuse("missing", `Table "${tableName}" not found`);
  }

  // The wire contract IS the row shape here (`pg_indexes.indexname` is `name`,
  // `indexdef` is `text`), so the value's own row schema parses the read.
  const indexes = await executeRows(db, {
    query: sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${tableName} ORDER BY indexname`,
    row: IndexSchema,
    label: "studio table indexes",
  });

  return { indexes };
}

// External `fixed`, not `db`: the loader reads only `information_schema` and
// `pg_indexes` (`pg_catalog`), which the change feed cannot see (it triggers
// `public` tables), so a `db` read-set would be empty and never fire. Nothing
// needs it to: the schema is migrated at boot, before any read is served, and
// no DDL runs mid-process — a schema change is a new process. (A
// `no-db-backed-notify` sanctioned exemption in this plugin's exempt/index.ts
// records the catalog read.)
export const tableIndexesServed = serveValue(tableIndexes, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "the public schema is migrated at boot, before any read; no DDL runs mid-process",
    },
  },
  loader: loadIndexes,
});
