import type {
  Rollup,
  RollupReconcile,
} from "@plugins/database/plugins/derived-tables/core";
import { rebuildDerivedTables } from "../internal/rebuild";

/**
 * Install `rollups` onto a throwaway test database (`createTestDb`) whose
 * source tables exist, and reconcile them — the SAME code path the boot schema
 * layer runs (prepare the tables, install the trigger sets, reconcile), so the DDL and the reconcile under test
 * are byte-identical to what a backend installs. Safe to call again: a second
 * call installs only what changed and reconciles.
 */
export async function installRollups(
  db: Parameters<typeof rebuildDerivedTables>[0],
  rollups: readonly Rollup[],
): Promise<RollupReconcile[]> {
  return rebuildDerivedTables(db, rollups);
}
