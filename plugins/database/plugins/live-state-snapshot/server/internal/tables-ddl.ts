import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import {
  LIVE_STATE_CHANGELOG_HORIZON_TABLE,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_HANDOFF_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
} from "@plugins/database/plugins/derived-views/core";

// `live_state_snapshot` — the persisted materialized value. One row per
// (resource_key, params_key); `params_key = "{}"` for the param-less
// boot-critical resources L2 v1 covers. `value` is the FULL loader output (same
// granularity as the snapshot endpoint). `position` is the xmin watermark
// captured BEFORE the value's reads (the 64-bit xid8 family, stored as numeric).
//
// Created via CREATE TABLE IF NOT EXISTS on boot — derived state, NOT a drizzle
// migration (same pattern as derived_view_state). The changelog
// table is created by change-feed inside its trigger-rebuild txn (it writes it
// from the trigger function); the snapshot table is owned here because only the
// runtime persist hook and the boot read touch it. See
// research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.2.
const SNAPSHOT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${LIVE_STATE_SNAPSHOT_TABLE} (
  resource_key text    NOT NULL,
  params_key   text    NOT NULL,
  value        jsonb   NOT NULL,
  position     numeric NOT NULL,
  tables_read  text[]  NOT NULL DEFAULT '{}'::text[],
  persisted_at timestamptz NOT NULL DEFAULT now(),
  definition    text,
  definition_at timestamptz,
  position_at   timestamptz,
  PRIMARY KEY (resource_key, params_key)
);
`;

// Idempotent in-place upgrade for snapshot tables created before `tables_read`
// existed: pre-existing rows get the `'{}'` default (treated as "no usable
// read-set" → force-FULL once on the next boot, which re-persists the real
// read-set). Derived DDL, NOT a drizzle migration — same pattern as the CREATE.
const SNAPSHOT_TABLE_ADD_TABLES_READ = `
ALTER TABLE ${LIVE_STATE_SNAPSHOT_TABLE}
  ADD COLUMN IF NOT EXISTS tables_read text[] NOT NULL DEFAULT '{}'::text[];
`;

// Idempotent in-place rename for snapshot tables created when the write-time
// stamp was spelled `updated_at`. It is WHEN THIS PROCESS LAST PERSISTED THE
// ROW — a write-time stamp, not a content-derived `updated_at` (which, repo-wide,
// means "maintained by derived-updated-at"). Guarded on information_schema so it
// is a no-op on a fresh table (already `persisted_at`) and on a second boot.
const SNAPSHOT_TABLE_RENAME_PERSISTED_AT = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = '${LIVE_STATE_SNAPSHOT_TABLE}'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE ${LIVE_STATE_SNAPSHOT_TABLE} RENAME COLUMN updated_at TO persisted_at;
  END IF;
END
$$;
`;

// Idempotent in-place upgrade adding the L2 definition columns (A18 / C22):
//  - `definition`    — the fingerprint of the compiled SQL that wrote the value;
//  - `definition_at` — stamped with the same `now()` as `persisted_at` by every
//    writer that knows the column. NO default on purpose: an older backend's
//    upsert (a hot swap) moves `persisted_at` and leaves this behind, so the
//    row it wrote stops matching the usable-row predicate instead of carrying
//    the new definition over an old value;
//  - `position_at`   — when a REPLACE persist last set `position` (a floor
//    persist keeps it): the compact job's age, NULL until a replace wrote it.
// Existing rows get NULL `definition_at` and so fail the predicate once — the
// intended one-time recompute. Derived DDL, NOT a drizzle migration.
const SNAPSHOT_TABLE_ADD_DEFINITION = `
ALTER TABLE ${LIVE_STATE_SNAPSHOT_TABLE}
  ADD COLUMN IF NOT EXISTS definition text,
  ADD COLUMN IF NOT EXISTS definition_at timestamptz,
  ADD COLUMN IF NOT EXISTS position_at timestamptz;
`;

// `live_state_changelog_horizon` — ONE row: the highest changelog xid the
// prune ever deleted (`max_pruned_xid`), written by the prune's own statement
// (`pruneChangelog`), NULL while nothing was. It is what catch-up judges a floor
// by: history at or after a floor is missing exactly when the prune deleted a
// row at or after it. The oldest RETAINED xid cannot say that — the changelog
// is sparse (a row per write), so after any prune the oldest survivor sits
// above the snapshot floor with nothing missing in between, and every boot
// would clear and recompute every persisted key.
const HORIZON_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  max_pruned_xid numeric
);
`;

// `live_state_handoff` — the epoch handoff (`./handoff`): one row per backend
// boot that shut down cleanly, the tuples it vouched for at its feed cut and
// the cut's xid (xid8, as numeric), read by its successor. A row older than an
// hour is deleted by the next write. Derived state, NOT a drizzle migration.
const HANDOFF_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${LIVE_STATE_HANDOFF_TABLE} (
  epoch      text        PRIMARY KEY,
  cut_xid    numeric     NOT NULL,
  tuples     jsonb       NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now()
);
`;

const PresentRowSchema = z.object({ present: z.boolean() });

async function relationExists(
  db: NodePgDatabase,
  name: string,
): Promise<boolean> {
  const row = await executeOne(db, {
    query: drizzleSql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`,
    row: PresentRowSchema,
    label: "ensureSnapshotTable/relation-exists",
  });
  return row.present;
}

// Create the horizon and seed its row when it has none (a new table; a
// database restored without it). What was pruned before the row existed is
// unknown, so the seed is the most that could have been — the old rule, frozen
// at that instant:
//  - no changelog yet → nothing was ever pruned (NULL);
//  - a changelog with rows → everything below its oldest row may have been;
//  - an empty changelog → everything so far may have been (the current xid).
// A fork copies the row: xids are cluster-wide, so the source's horizon lies
// below every position the fork will ever persist. `ON CONFLICT DO NOTHING`: a
// concurrent boot (hot swap) seeds it once.
async function ensureChangelogHorizon(db: NodePgDatabase): Promise<void> {
  await db.execute(drizzleSql.raw(HORIZON_TABLE_DDL));
  const seeded = await executeOne(db, {
    query: drizzleSql.raw(
      `SELECT EXISTS (SELECT 1 FROM ${LIVE_STATE_CHANGELOG_HORIZON_TABLE}) AS present`,
    ),
    row: PresentRowSchema,
    label: "ensureSnapshotTable/horizon-seeded",
  });
  if (seeded.present) return;
  const seed = (await relationExists(db, LIVE_STATE_CHANGELOG_TABLE))
    ? `SELECT true, COALESCE(min(xid) - 1, pg_current_xact_id()::text::numeric)
       FROM ${LIVE_STATE_CHANGELOG_TABLE}`
    : `SELECT true, NULL::numeric`;
  await db.execute(
    drizzleSql.raw(
      `INSERT INTO ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} (id, max_pruned_xid)
       ${seed}
       ON CONFLICT (id) DO NOTHING`,
    ),
  );
}

export async function ensureSnapshotTable(db: NodePgDatabase): Promise<void> {
  await db.execute(drizzleSql.raw(SNAPSHOT_TABLE_DDL));
  await db.execute(drizzleSql.raw(SNAPSHOT_TABLE_ADD_TABLES_READ));
  await db.execute(drizzleSql.raw(SNAPSHOT_TABLE_RENAME_PERSISTED_AT));
  await db.execute(drizzleSql.raw(SNAPSHOT_TABLE_ADD_DEFINITION));
  await ensureChangelogHorizon(db);
  await db.execute(drizzleSql.raw(HANDOFF_TABLE_DDL));
}
