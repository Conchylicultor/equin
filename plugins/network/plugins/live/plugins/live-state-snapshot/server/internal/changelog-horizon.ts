import { sql as drizzleSql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  LIVE_STATE_CHANGELOG_HORIZON_TABLE,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
} from "@plugins/database/plugins/derived-views/core";

// Hard time-ceiling on retained changelog history. Beyond this, a row is pruned
// even if a stale snapshot floor would otherwise pin it — bounding the table even
// when a resource hasn't re-persisted in a long time. A server down longer than
// this falls to the FULL backstop in catch-up (bounded and correct).
const RETENTION = "24 hours";

/**
 * Prune the durable changelog, and record what it deleted in the SAME
 * statement: the prune horizon (`max_pruned_xid`) moves to the highest xid this
 * run deleted, never down. Catch-up judges a floor by that horizon, so it can
 * never disagree with what was actually deleted.
 *
 * The safe lower bound is `xid < min(position)`: every persisted snapshot
 * already incorporates every row strictly older than its own watermark, so a
 * row below the GLOBAL floor can never be needed by catch-up — and never moves
 * the horizon to or past any floor. COALESCE(min(position), 0) keeps the prune
 * correct when no snapshot exists yet (floor 0 ⇒ only the time-ceiling clause
 * prunes). The `at < now() - RETENTION` clause is the independent hard
 * ceiling, and the only one that can delete a row at or after a floor — which
 * the horizon then says. See
 * research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.7.
 */
export async function pruneChangelog(db: NodePgDatabase): Promise<void> {
  await db.execute(
    drizzleSql.raw(
      `WITH pruned AS (
         DELETE FROM ${LIVE_STATE_CHANGELOG_TABLE}
         WHERE xid < (SELECT COALESCE(min(position), 0) FROM ${LIVE_STATE_SNAPSHOT_TABLE})
            OR at < now() - interval '${RETENTION}'
         RETURNING xid
       )
       INSERT INTO ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} (id, max_pruned_xid)
       SELECT true, max(xid) FROM pruned
       ON CONFLICT (id) DO UPDATE
         SET max_pruned_xid = GREATEST(
           ${LIVE_STATE_CHANGELOG_HORIZON_TABLE}.max_pruned_xid,
           EXCLUDED.max_pruned_xid
         )`,
    ),
  );
}

const HorizonRowSchema = z.object({ max_pruned_xid: z.string().nullable() });

/**
 * The prune horizon: the highest changelog xid ever pruned, null when none
 * was. The row is seeded when the table is created (`ensureSnapshotTable`), so
 * a missing row is a broken boot, not "nothing pruned" — it throws.
 */
export async function readPruneHorizon(
  db: NodePgDatabase,
): Promise<string | null> {
  const rows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT max_pruned_xid::text AS max_pruned_xid
       FROM ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} WHERE id`,
    ),
    row: HorizonRowSchema,
    label: "readPruneHorizon",
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `${LIVE_STATE_CHANGELOG_HORIZON_TABLE} has no row — ensureSnapshotTable seeds it at boot; catch-up cannot tell what was pruned without it`,
    );
  }
  return row.max_pruned_xid;
}

/**
 * Was the changelog pruned past `position` — did the prune delete a row at or
 * after it? Then history a row floored there needs is gone, and it cannot be
 * caught up. Compared as BigInt (xid8 stored as numeric; non-negative
 * integers).
 */
export function isPrunedPast(
  position: string,
  horizon: string | null,
): boolean {
  return horizon !== null && BigInt(horizon) >= BigInt(position);
}
