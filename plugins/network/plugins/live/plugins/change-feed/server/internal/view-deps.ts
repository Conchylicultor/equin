import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";

// Bridges the impedance mismatch between where changes ORIGINATE and where the
// read-set OBSERVES them. Triggers fire on base tables (you cannot put a row
// trigger on a view), but a loader may read from the derived-views layer
// (`tasks_v`, `agents_v`, …) — so the L3 read-set records the VIEW name, not
// the base table.
//
// This module reads, once at boot (after derived-views are rebuilt), the
// forward view graph: each public view → the relations it DIRECTLY reads (a
// view reading another view is an edge here). `./relation-bases` expands it,
// transitively and through the rollups, into the base tables a read of each
// relation depends on.

// `information_schema.view_table_usage` types its name columns as the
// `sql_identifier` domain, which Postgres resolves to its base type on the wire —
// a scalar `name` (OID 19), which pg decodes to a string. Measured, not assumed.
//
// Both ends are filtered to `public`: the graph is keyed by bare name (as the
// read-set and the feed are), so a view reading another schema's same-named
// table must not be confused with the public one.
const ViewUsageRowSchema = z.object({
  view_name: z.string(),
  table_name: z.string(),
});

/** Each public view → the relations it directly reads (sorted). */
export async function buildViewDeps(
  db: NodePgDatabase,
): Promise<Map<string, string[]>> {
  const rows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT view_name, table_name
       FROM information_schema.view_table_usage
       WHERE view_schema = 'public' AND table_schema = 'public'`,
    ),
    row: ViewUsageRowSchema,
    label: "buildViewDeps",
  });
  const map = new Map<string, Set<string>>();
  for (const { view_name, table_name } of rows) {
    let set = map.get(view_name);
    if (!set) {
      set = new Set();
      map.set(view_name, set);
    }
    set.add(table_name);
  }
  return new Map([...map].map(([view, reads]) => [view, [...reads].sort()]));
}
