import { sql as drizzleSql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { LIVE_STATE_SNAPSHOT_TABLE } from "@plugins/database/plugins/derived-views/core";

// A6 of research/2026-10-01-global-scoped-change-routing-p5-p8.md: no
// L2-persisted reader of a PRODUCED table (one whose change source is an
// in-process change producer — change-feed's `defineChangeProducer`).
//
// A producer is volatile: its changes have no changelog row, so a change still
// coalescing when the backend restarts is gone, and the cold-boot catch-up has
// nothing to replay. For a live subscription that is bounded — clients
// resubscribe and load in full. For an L2 row it is not: the persisted value
// would be served to every page load, stale, until something else happened to
// recompute it. So "lost" must never become "persisted wrong", enforced three
// ways:
//
//  - BOOT, static evidence (`assertNoPersistedProducedReader`): a key the
//    runtime persists (`persistedKeys()`, its own gate) whose declared routes
//    or identity table name a produced table blocks boot.
//  - BOOT, stale rows (`sweepProducedSnapshots`): a persisted row whose
//    `tables_read` reaches a produced table is deleted and reported once, never
//    thrown on — it can predate the code that would stop writing it.
//  - RUNTIME (`createProducedPersistGuard`): a persist whose guard tables
//    (`PersistMeta.guardTables` — a replace's captured read-set, a floor
//    persist's route tables or read-set union, never empty, so a floor
//    persist's first INSERT is judged too) reach a produced table is refused — every time, so the key never writes a
//    row again in this process; the first refusal deletes its row and reports,
//    once — which also breaks the loop report → recordReport → emit →
//    recompute → refuse. The runtime's persist GATE (`shouldPersist`) is left
//    alone on purpose: the runtime assumes it fixed for the process (snapshot
//    ownership, the `{}` routed target and `isPersisted` all read it), so a
//    refusal drops the WRITE, never flips the key's persisted-ness.
//
// "Reaches" is through the relation bases (D28): a read-set names the views and
// rollups a loader read, so each relation is expanded to the base tables that
// feed it (change-feed's `relationBases`, passed in) — a persisted reader of a
// view over a produced table is as stale as a reader of the table itself.

/** The base tables a relation depends on (change-feed's `relationBases`). */
export type RelationBases = (relation: string) => readonly string[];

// The produced bases a read-set reaches, deduplicated, in read-set order.
function producedBasesOf(
  tablesRead: readonly string[],
  produced: ReadonlySet<string>,
  relationBases: RelationBases,
): string[] {
  const hits = new Set<string>();
  for (const relation of tablesRead) {
    for (const base of relationBases(relation)) {
      if (produced.has(base)) hits.add(base);
    }
  }
  return [...hits];
}

/** One table a resource's delivery depends on (server-core's `scopedResourceTables()`). */
export interface ResourceTable {
  key: string;
  table: string;
  via: string;
}

/** The persisted keys' dependencies on a produced table. Pure. */
export function findPersistedProducedReaders(
  persisted: readonly string[],
  scoped: readonly ResourceTable[],
  produced: ReadonlySet<string>,
): ResourceTable[] {
  const keys = new Set(persisted);
  return scoped
    .filter((r) => keys.has(r.key) && produced.has(r.table))
    .sort((a, b) => a.key.localeCompare(b.key) || a.via.localeCompare(b.via));
}

/** A6 (boot): throw unless no persisted key reads a produced table. */
export function assertNoPersistedProducedReader(
  persisted: readonly string[],
  scoped: readonly ResourceTable[],
  produced: ReadonlySet<string>,
): void {
  const readers = findPersistedProducedReaders(persisted, scoped, produced);
  if (readers.length === 0) return;
  throw new Error(
    `[live-state-snapshot] ${readers.length} L2-persisted resource dependency(ies) on a produced table (A6) — a change producer is volatile (a pending change is lost on restart, with no changelog to replay), so a persisted value over it would be served stale to every page load:\n` +
      readers.map((r) => `  - ${r.key}  →  ${r.via} "${r.table}"`).join("\n") +
      "\nFix: drop the resource's `preload` (it is then a live subscription, which reloads in full on resubscribe), or read a triggered table instead.",
  );
}

const SnapshotTablesSchema = z.object({
  resource_key: z.string(),
  params_key: z.string(),
  tables_read: z.array(z.string()),
});

const SnapshotPkSchema = z.object({
  resource_key: z.string(),
  params_key: z.string(),
});

/** One row the stale-row sweep deleted: its PK, its read-set, the produced bases it reached. */
export interface SweptProducedRow {
  resource_key: string;
  params_key: string;
  tables_read: string[];
  produced: string[];
}

/**
 * A6 (boot, stale rows): delete every persisted row whose `tables_read`
 * reaches a produced table through the relation bases, returning what was
 * deleted. A no-op (no query) when no table is produced. The expansion runs
 * here, not in SQL: the bases are the change feed's boot graph. The delete is
 * per row (`(resource_key, params_key)`, the PK), so a row whose own read-set
 * reaches no produced table survives, and only rows the delete really removed
 * are returned.
 */
export async function sweepProducedSnapshots(
  db: NodePgDatabase,
  produced: ReadonlySet<string>,
  relationBases: RelationBases,
): Promise<SweptProducedRow[]> {
  if (produced.size === 0) return [];
  const rows = await executeRows(db, {
    query: drizzleSql`
      SELECT resource_key, params_key, tables_read
        FROM ${drizzleSql.raw(LIVE_STATE_SNAPSHOT_TABLE)}
       ORDER BY resource_key, params_key
    `,
    row: SnapshotTablesSchema,
    label: "sweepProducedSnapshots.read",
  });
  const swept: SweptProducedRow[] = [];
  for (const row of rows) {
    const hits = producedBasesOf(row.tables_read, produced, relationBases);
    if (hits.length > 0) swept.push({ ...row, produced: hits });
  }
  if (swept.length === 0) return [];
  const deleted = await executeRows(db, {
    query: drizzleSql`
      DELETE FROM ${drizzleSql.raw(LIVE_STATE_SNAPSHOT_TABLE)}
       WHERE (resource_key, params_key) IN (${drizzleSql.join(
         swept.map((r) => drizzleSql`(${r.resource_key}, ${r.params_key})`),
         drizzleSql`, `,
       )})
      RETURNING resource_key, params_key
    `,
    row: SnapshotPkSchema,
    label: "sweepProducedSnapshots.delete",
  });
  const gone = new Set(
    deleted.map((r) => JSON.stringify([r.resource_key, r.params_key])),
  );
  return swept.filter((r) =>
    gone.has(JSON.stringify([r.resource_key, r.params_key])),
  );
}

/**
 * A6 (runtime): the persist-hook guard. `refuses(key, tablesRead)` is true when
 * the read-set reaches a produced table through the relation bases, and from then on for that key whatever
 * it reads (a later read-set that happens to miss the table must not resume
 * writing a row this process already judged unsafe). `onRefused` runs on the
 * first refusal only (to delete the key's row and report). Never consulted by
 * the runtime's persist gate — see the header.
 */
export function createProducedPersistGuard(opts: {
  produced: ReadonlySet<string>;
  relationBases: RelationBases;
  onRefused: (key: string, producedTables: readonly string[]) => Promise<void>;
}): {
  refuses(key: string, tablesRead: readonly string[]): Promise<boolean>;
} {
  const refused = new Set<string>();
  return {
    async refuses(key, tablesRead) {
      if (refused.has(key)) return true;
      const hits = producedBasesOf(
        tablesRead,
        opts.produced,
        opts.relationBases,
      );
      if (hits.length === 0) return false;
      refused.add(key);
      await opts.onRefused(key, hits);
      return true;
    },
  };
}
