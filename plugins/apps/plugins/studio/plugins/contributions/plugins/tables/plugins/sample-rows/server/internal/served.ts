import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  executeRows,
  executeResult,
} from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { tableSampleRows } from "../../shared/resources";

const TableNameRowSchema = z.object({ table_name: z.string() });

// `SELECT *` over a table nobody named at build time: the honest schema says a
// row is an object and stops there. Widening it further (`z.any()`) or claiming
// a shape would both be lies — this is genuinely all that is known.
const SampleRowSchema = z.record(z.string(), z.unknown());

async function loadSampleRows({ tableName }: { tableName: string }) {
  const exists = await executeRows(db, {
    query: sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${tableName}`,
    row: TableNameRowSchema,
    label: "studio table exists (sample rows)",
  });
  if (exists.length === 0) {
    throw tableSampleRows.refuse("missing", `Table "${tableName}" not found`);
  }

  // Quoted, so the read-set captures the table by name (a quoted FROM name is
  // taken as written).
  const quotedTable = `"${tableName.replace(/"/g, '""')}"`;
  const result = await executeResult(db, {
    query: sql`SELECT * FROM ${sql.raw(quotedTable)} LIMIT 10`,
    row: SampleRowSchema,
    label: `studio sample rows for ${tableName}`,
  });

  // Column names come from the result descriptor, not from the first row.
  // Reading them off `rows[0]` reported an empty table as having NO columns,
  // which is a claim about its schema that is simply false; `fields` carries the
  // real column list even when the table is empty.
  return { columns: result.fields.map((f) => f.name), rows: result.rows };
}

// A snapshot, not `db`: the loader samples ANY public relation the reader
// names, and the change feed covers only some of them — a view, a derived-table
// rollup or an `ExcludeFromChangeFeed` table (`traces`, `slow_ops`, the latency
// ledger) never fires, so under `db` its sample would sit frozen at its first
// load while claiming to be fresh. Re-read whenever a reader asks; the section
// offers Refresh. (A `no-db-backed-notify` sanctioned exemption in this
// plugin's exempt/index.ts records the Postgres read.)
export const tableSampleRowsServed = serveValue(tableSampleRows, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "it samples any public relation, and views, rollups and change-feed-excluded tables have no change signal",
    },
  },
  loader: loadSampleRows,
});
