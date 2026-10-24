import type { PgTable } from "drizzle-orm/pg-core";
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import { tableLabel } from "./table-label";

// A plugin leaves ITS OWN table's ROWS out of the nightly backup by adding
// `ExcludeFromBackup({ table, reason })` to its server `contributions`. The
// archive keeps the table's DDL; a restore gives an empty table.
//
// A SEPARATE DECISION FROM `ExcludeFromFork` (./fork-exclusion), on purpose.
// The fork asks "does a fresh worktree need these rows?"; the backup asks "does
// losing these rows cost anything?". The answers often differ: `mail_sync_state`
// stays in every fork (a worktree still needs the account's sync state) yet is
// left out of backups, together with the Gmail corpus it watermarks. So neither
// token implies the other.
//
// A kept table must not have a foreign key to a left-out one: the restore would
// fail re-adding it. In the schema this checkout declares, that is refused
// (`BackupPlanError`, ./backup-plan) — leave the linking table out too, or
// replace the link with a plain id. A database on an OLDER schema that still
// has such a link keeps the linked table's rows instead (./backup-plan).
//
// `reason` MUST SAY ONE OF TWO THINGS:
//
//   - **The rows expire anyway.** `traces` is 7-day debugging evidence swept
//     nightly; a restore a week later would find it gone regardless.
//   - **How the rows come back.** A cache rebuilt from a file or an upstream
//     source (the chord trainer's song index reloads from its snapshot; the
//     mail corpus is refetched from Gmail by the next sync).
//
// Anything a human authored, or that nothing can rebuild, does not qualify.
// And because a restore hands the owning plugin an EMPTY table, that plugin
// must treat empty as a normal state (rebuild, or simply show nothing), never
// as corruption.
//
// Table-level only. Nothing needs a schema-level form today; it can be added the
// way the fork's was.
export const ExcludeFromBackup = defineServerContribution<{
  table: PgTable | string;
  reason: string;
}>("backup-data-exclusion", { docLabel: (c) => tableLabel(c.table) });

/**
 * What `backupDatabase` must leave out — the DECLARED set, verbatim. Pure data;
 * turning it into `pg_dump` flags needs the database, see ./backup-plan.
 */
export interface BackupExclusions {
  /** Table names in the app schema (`public`) whose rows are left out. */
  readonly tables: readonly string[];
}

// The declared exclusion set.
//
// THROWS on an empty set, like `forkExclusions()`. A process that never
// collected contributions already throws inside `getContributions()`; an empty
// collected set would mean "leave nothing out", a full backup that looks like it
// worked. `traces` guarantees a non-empty set in any process that collects — the
// backup body runs in `./equin supervised-exec`, which does.
export function backupExclusions(): BackupExclusions {
  const tables = ExcludeFromBackup.getContributions();
  if (tables.length === 0) {
    throw new Error(
      "backupExclusions(): no backup exclusions are registered by any loaded plugin.",
    );
  }
  return { tables: tables.map((c) => tableLabel(c.table)) };
}
