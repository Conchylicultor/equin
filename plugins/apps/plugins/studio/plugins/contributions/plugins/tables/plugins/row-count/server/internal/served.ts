import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { tableRowCount } from "../../shared/resources";

const TableNameRowSchema = z.object({ table_name: z.string() });

// `n_live_tup` is `int8`, which node-postgres hands back as a STRING; the
// `::int` cast in the query is what makes this column genuinely a number.
const EstimateRowSchema = z.object({ estimate: z.number() });

async function loadRowCount({ tableName }: { tableName: string }) {
  const tableCheck = await executeRows(db, {
    query: sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${tableName}`,
    row: TableNameRowSchema,
    label: "studio table exists (row count)",
  });
  if (tableCheck.length === 0) {
    throw tableRowCount.refuse("missing", `Table "${tableName}" not found`);
  }

  const rows = await executeRows(db, {
    query: sql`SELECT n_live_tup::int AS estimate FROM pg_stat_user_tables WHERE relname = ${tableName}`,
    row: EstimateRowSchema,
    label: "studio table row-count estimate",
  });

  // `information_schema.tables` also lists views, and a view has no
  // `pg_stat_user_tables` entry at all — so "no row" here means "there is no
  // estimate for this relation", which is exactly what `null` reports. It is a
  // real answer, not a swallowed read failure (a failed read throws above).
  const [row] = rows;
  return { estimate: row?.estimate ?? null };
}

// A snapshot, not `db`: the loader reads `pg_stat_user_tables`, a statistics
// view the change feed cannot see (it triggers `public` tables) and the
// collector updates asynchronously, so a `db` read-set would be empty and
// never fire. The estimate is re-read whenever a reader asks. (A
// `no-db-backed-notify` sanctioned exemption in this plugin's exempt/index.ts
// records the catalog read.)
export const tableRowCountServed = serveValue(tableRowCount, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "the statistics collector's running estimate (pg_stat_user_tables) has no change signal",
    },
  },
  loader: loadRowCount,
});
