import { stat } from "node:fs/promises";
import { pgClientBin } from "@plugins/database/plugins/client-tools/server";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { z } from "zod";
import { libpqSubprocessEnv, openShortLivedClient } from "./pool";
import {
  resolveBackupPlan,
  type BackupPlan,
  type BackupPlanOptions,
} from "./backup-plan";
import type { BackupExclusions } from "./backup-exclusion";

export type TableStat = {
  name: string;
  rowCount: number;
  /**
   * The archive holds this table's DDL but not its rows (an
   * `ExcludeFromBackup`). `rowCount` is still the live database's count, so a
   * manifest must not add it to the rows it claims to have backed up.
   */
  rowsExcluded: boolean;
};

export type BackupInfo = {
  name: string;
  sizeBytes: number;
  tables: TableStat[];
};

// Dumps `name` into `outFile` (custom format), leaving out the rows of every
// declared `ExcludeFromBackup` table that exists in this database.
//
// `exclusions` is REQUIRED rather than read from the registry here, for the same
// reason `forkDatabase` takes its set: a registry read answers `[]` in a process
// that never collected contributions, and that would be a silent full backup.
// `backupExclusions()` in ./backup-exclusion is the loud way to get the set.
//
// `options.strict` says whether this database's schema is the one this checkout
// declares (see ./backup-plan): refuse a kept → left-out link, or keep the rows.
//
// Returns the plan so the caller can say in the manifest what was left out, and
// what was kept after all.
export async function backupDatabase(
  name: string,
  outFile: string,
  exclusions: BackupExclusions,
  options: BackupPlanOptions,
): Promise<BackupPlan> {
  const plan = await resolveBackupPlan(name, exclusions, options);
  // Findings, not failures: a composition database may simply not have the
  // table, or be on an older schema that still links to it. Logged so they land
  // in the backup transcript.
  for (const line of plan.unmatched) {
    console.warn(
      `[db-backup] ${name}: declared exclusion matches nothing: ${line}`,
    );
  }
  for (const k of plan.keptForLinks) {
    console.warn(
      `[db-backup] ${name}: kept rows of "${k.table}": "${k.linkedFrom}" still links to it (${k.constraint})`,
    );
  }
  // `-f` into the file rather than streaming stdout through Bun into it: Bun can
  // drop the tail of a streamed dump (see the dump-to-file note in ./fork).
  // `background: true` lets the interactive backends win the CPU while the
  // dump compresses.
  const result = await spawnCaptured(
    [
      pgClientBin("pg_dump"),
      "-Fc",
      "-f",
      outFile,
      ...plan.excludeTableData.map((t) => `--exclude-table-data=${t}`),
      name,
    ],
    {
      env: { ...process.env, ...libpqSubprocessEnv() },
      tier: "background",
      unbounded:
        "supervised backup child: nothing shorter than the dump itself bounds it",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `pg_dump failed for ${name} (exit ${result.exitCode ?? result.signalCode}): ${result.stderr}`,
    );
  }
  return plan;
}

/**
 * `n_live_tup` is `bigint`, and `pg` hands a `bigint` back as a STRING — a row
 * count can exceed 2^53, so there is no number it could losslessly decode to.
 * The schema says so; `readTableStats` converts it below, which is safe because
 * the value only ever becomes a cosmetic manifest label.
 */
const TableStatRowSchema = z.object({
  relname: z.string(),
  n_live_tup: z.string(),
});

// Table + estimated-row stats read straight from the source DB catalog. This is
// a cheap metadata query against pg_stat_user_tables — it never decompresses the
// dump. `n_live_tup` is Postgres's own live-row estimate (kept current by
// autovacuum/ANALYZE), which is exactly what the cosmetic manifest label needs;
// the previous approach ran `pg_restore --data-only` to re-decompress the whole
// dump and count every row line-by-line in JS, roughly doubling the dump cost.
async function readTableStats(
  name: string,
  excludedTables: readonly string[],
): Promise<TableStat[]> {
  const pool = openShortLivedClient(name);
  try {
    const rows = await queryRows(pool, {
      // `relname` is a `name`, cast so the column decodes as the `text` the
      // schema declares.
      sql: `SELECT relname::text AS relname, n_live_tup
              FROM pg_stat_user_tables ORDER BY relname`,
      row: TableStatRowSchema,
    });
    return rows.map((r) => ({
      name: r.relname,
      rowCount: Number(r.n_live_tup),
      rowsExcluded: excludedTables.includes(r.relname),
    }));
  } finally {
    await pool.end();
  }
}

// `excludedTables` is the `BackupPlan.excludedTables` of the dump being
// inspected, so the tables whose rows it left out are marked rather than
// counted as backed up.
export async function inspectBackup(
  file: string,
  name: string,
  excludedTables: readonly string[],
): Promise<BackupInfo> {
  const [fileStat, tables] = await Promise.all([
    stat(file),
    readTableStats(name, excludedTables),
  ]);
  return { name, sizeBytes: fileStat.size, tables };
}
