import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  tableForeignKeys,
  OutgoingFkSchema,
  IncomingFkSchema,
} from "../../shared/resources";

// Aliased so the schema key and the result key cannot drift — an unaliased
// `SELECT 1` comes back under Postgres' `?column?` placeholder.
const TableExistsRowSchema = z.object({ present: z.number() });

async function loadForeignKeys({ tableName }: { tableName: string }) {
  const tableCheck = await executeRows(db, {
    query: sql`SELECT 1 AS present FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${tableName}`,
    row: TableExistsRowSchema,
    label: "studio table exists (foreign keys)",
  });
  if (tableCheck.length === 0) {
    throw tableForeignKeys.refuse("missing", `Table "${tableName}" not found`);
  }

  // Every column below is an `information_schema` identifier (`name`, OID 19) —
  // scalar, decoded as a string — so the value's own schemas are the honest
  // row shapes and parse the reads directly.
  const [outgoing, incoming] = await Promise.all([
    executeRows(db, {
      query: sql`SELECT tc.constraint_name, kcu.column_name,
           ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
       AND tc.table_name = ${tableName}
     ORDER BY tc.constraint_name, kcu.column_name`,
      row: OutgoingFkSchema,
      label: "studio outgoing foreign keys",
    }),
    executeRows(db, {
      query: sql`SELECT tc.constraint_name, tc.table_name AS source_table, kcu.column_name AS source_column,
           ccu.column_name AS target_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
       AND ccu.table_name = ${tableName}
     ORDER BY tc.table_name, tc.constraint_name`,
      row: IncomingFkSchema,
      label: "studio incoming foreign keys",
    }),
  ]);

  return { outgoing, incoming };
}

// External `fixed`, not `db`: the loader reads only `information_schema`,
// which the change feed cannot see (it triggers `public` tables), so a `db`
// read-set would be empty and never fire. Nothing needs it to: the schema is
// migrated at boot, before any read is served, and no DDL runs mid-process —
// a schema change is a new process. (A `no-db-backed-notify` sanctioned
// exemption in this plugin's exempt/index.ts records the catalog read.)
export const tableForeignKeysServed = serveValue(tableForeignKeys, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "the public schema is migrated at boot, before any read; no DDL runs mid-process",
    },
  },
  loader: loadForeignKeys,
});
