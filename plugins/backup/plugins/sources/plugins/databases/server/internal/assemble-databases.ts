import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import {
  listDatabases,
  backupDatabase,
  backupExclusions,
  inspectBackup,
} from "@plugins/database/plugins/admin/server";
import type {
  KeptForLink,
  TableStat,
} from "@plugins/database/plugins/admin/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { hasCompositionMarker } from "@plugins/infra/plugins/worktree/server";
import type {
  BackupSourceItem,
  BackupSourceReport,
} from "@plugins/backup/core";
import { databasesSourceConfig } from "../../shared/config";
import {
  classifyDatabase,
  isBackedUp,
  type DatabaseKind,
} from "./select-databases";

/** One database that could not be dumped, and what it said. */
interface FailedDump {
  db: string;
  error: string;
}

export async function assembleDatabases(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(databasesSourceConfig);

  if (!enabled) {
    return {
      id: "databases",
      name: "Databases",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  // Read once, before any dump: it throws in a process that never collected
  // contributions, which must fail the source rather than dump everything.
  const exclusions = backupExclusions();
  const classified = await Promise.all(
    (await listDatabases()).map(async (name) => ({
      name,
      kind: await classifyDatabase(name, hasCompositionMarker),
    })),
  );
  const targetDbs = classified
    .filter((d) => isBackedUp(d.kind))
    .map((d) => d.name);
  const leftOut = describeLeftOut(classified);
  // The running namespace's own database was migrated at boot, so its schema is
  // the one this checkout declares: a kept → left-out link there is a bad
  // declaration and fails the dump. Every other database may be on an older
  // schema, and keeps the linked rows instead (see `planBackupExclusions`).
  const ownDb: string = runtimeNamespace();

  // Dump every target DB concurrently — each pg_dump is an independent
  // subprocess writing its own file, so there is no cross-DB ordering.
  //
  // `allSettled`, not `all`: ONE database must not cost the archive the others,
  // and it used to. On 2026-09-18/19 the exclusion planner refused a composition
  // database on an older schema (it is lenient there now — see
  // `planBackupExclusions`), `all` turned that refusal into a rejected source,
  // the source rejected the archive, and the run ended having backed up
  // NOTHING: no attachments, no secrets, no transcripts. A `pg_dump` can still
  // fail on its own, and the own database's strict plan can still refuse.
  //
  // So a database that cannot be dumped is now recorded and stepped over. The
  // source reports `failed`, which keeps the run off `ok` and puts the reason
  // on its card — it is degraded, loudly, instead of absent, silently.
  const settled = await Promise.allSettled(
    targetDbs.map(async (db) => {
      const out = join(dir, `${db}.dump`);
      try {
        const plan = await backupDatabase(db, out, exclusions, {
          strict: db === ownDb,
        });
        const info = await inspectBackup(out, db, plan.excludedTables);
        return {
          item: {
            label: db,
            detail: describeDump(info.tables, plan.keptForLinks),
            count: info.tables.length,
          },
          sizeBytes: info.sizeBytes,
        };
      } catch (err) {
        // A `pg_dump` that died part way leaves a truncated `.dump` behind, and
        // a truncated custom-format dump is the worst possible artifact: it is
        // in the archive, it is named after the database, and `pg_restore` only
        // discovers it is short when someone is restoring it. Reclaim it here
        // so the archive holds either a whole dump or no file at all.
        await rm(out, { force: true });
        throw err;
      }
    }),
  );

  const items: BackupSourceItem[] = [];
  const failures: FailedDump[] = [];
  let sizeBytes = 0;
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      items.push(result.value.item);
      sizeBytes += result.value.sizeBytes;
      return;
    }
    const err: unknown = result.reason;
    failures.push({
      db: targetDbs[i] ?? "(unknown)",
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (failures.length > 0) {
    return {
      id: "databases",
      name: "Databases",
      outcome: "failed",
      error: describeFailures(failures, targetDbs.length),
      items,
      leftOut,
      sizeBytes,
    };
  }

  return {
    id: "databases",
    name: "Databases",
    outcome: "included",
    items,
    leftOut,
    sizeBytes,
  };
}

/** e.g. "1 of 7 databases could not be dumped:\n  - sonata: …". */
function describeFailures(
  failures: readonly FailedDump[],
  attempted: number,
): string {
  const noun = failures.length === 1 ? "database" : "databases";
  const lines = failures.map((f) => `  - ${f.db}: ${f.error}`);
  return (
    `${failures.length} of ${attempted} ${noun} could not be dumped and ` +
    `${failures.length === 1 ? "is" : "are"} NOT in this archive:\n` +
    lines.join("\n")
  );
}

// e.g. "135 tables / 71934 rows (rows of 1 table left out: traces)". The row
// total counts only rows the archive holds; a left-out table is still counted
// as a table, because its DDL is in the archive.
//
// A table whose rows were kept only because this database still links to it
// says so, e.g. "(rows of mail_threads kept: mail_drafts still links to it)" —
// the one sign on the card that this database's schema is older than the code.
function describeDump(
  tables: readonly TableStat[],
  keptForLinks: readonly KeptForLink[],
): string {
  const rows = tables.reduce(
    (acc, t) => (t.rowsExcluded ? acc : acc + t.rowCount),
    0,
  );
  const notes: string[] = [];
  const excluded = tables.filter((t) => t.rowsExcluded).map((t) => t.name);
  if (excluded.length > 0) {
    const noun = excluded.length === 1 ? "table" : "tables";
    notes.push(
      `rows of ${excluded.length} ${noun} left out: ${excluded.join(", ")}`,
    );
  }
  for (const k of keptForLinks) {
    notes.push(`rows of ${k.table} kept: ${k.linkedFrom} still links to it`);
  }
  const base = `${tables.length} tables / ${rows} rows`;
  return notes.length === 0 ? base : `${base} (${notes.join("; ")})`;
}

const SKIPPED_KIND_LABEL: Record<
  Exclude<DatabaseKind, "main" | "composition" | "orphan">,
  string
> = {
  worktree: "worktree copies",
  test: "test databases",
  "fork-temp": "in-progress worktree copies",
};

// The run card's "Not backed up" list: the disposable kinds as ONE line of
// counts, and every orphan by name — no app owns it and nothing will reclaim
// it, so a person has to decide to drop it.
function describeLeftOut(
  classified: readonly { name: string; kind: DatabaseKind }[],
): BackupSourceItem[] {
  const counts = new Map<string, number>();
  const orphans: BackupSourceItem[] = [];
  for (const { name, kind } of classified) {
    if (kind === "main" || kind === "composition") continue;
    if (kind === "orphan") {
      orphans.push({
        label: name,
        detail: "no app owns this database",
      });
      continue;
    }
    const label = SKIPPED_KIND_LABEL[kind];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const disposable: BackupSourceItem[] =
    counts.size === 0
      ? []
      : [
          {
            label: [...counts].map(([label, n]) => `${n} ${label}`).join(", "),
            detail: "disposable, never backed up",
            count: [...counts.values()].reduce((a, n) => a + n, 0),
          },
        ];
  return [...disposable, ...orphans];
}
