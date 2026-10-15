import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import {
  dropDerivedViews,
  rebuildDerivedViews,
  type DeclaredView,
} from "@plugins/database/plugins/derived-views/server";
import { rebuildDerivedTables } from "@plugins/database/plugins/derived-tables/server";
import type {
  Rollup,
  RollupReconcile,
} from "@plugins/database/plugins/derived-tables/core";
import {
  installDerivedUpdatedAt,
  type DerivedUpdatedAtSpec,
} from "@plugins/database/plugins/derived-updated-at/server";
import {
  migrationClaimId,
  parseMigration,
} from "@plugins/database/plugins/migrations/core";
import { MIGRATIONS_TABLE_NAME } from "@plugins/database/plugins/derived-views/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";

const log = defineLogSink({
  id: "migrations",
  description:
    "DB migration runner ops log: DDL/data migrations applied on boot — timestamp order, each phased schema migration as one expand → claimed data → contract group.",
});

const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

// A packaged release reads the migration SQL files from a vendored dir via env
// override: `import.meta.dir` resolves into the compiled binary's virtual FS
// (not a real on-disk path), so the `../../data` relative lookup can't find the
// `.sql` files. The release vendors `data/` and points here. When unset (dev),
// resolve relative to this module as before.
const MIGRATIONS_DIR =
  process.env.SINGULARITY_MIGRATIONS_DIR ??
  join(import.meta.dir, "..", "..", "data");

export interface Migration {
  file: string;
  hash: string;
  sortKey: string;
  sqlText: string;
}

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

// Completion barrier for the boot schema layer. A parallel `onReadyBlocking` hook
// (e.g. the boot-snapshot warm-up) can await this instead of relying on hook
// ordering — `onReadyBlocking` hooks run in parallel. A committing
// `applySchemaLayer` settles it: resolves once the layer (migrations + derived
// layer) has committed, rejects if it throws. See
// research/2026-06-14-global-cold-load-instant-boot.md.
let resolveMigrationsReady!: () => void;
let rejectMigrationsReady!: (err: unknown) => void;
export const migrationsReady: Promise<void> = new Promise<void>(
  (resolve, reject) => {
    resolveMigrationsReady = resolve;
    rejectMigrationsReady = reject;
  },
);

// Ordered list of every migration file on disk, in timestamp order — the order
// `planSchemaSteps` walks them.
export function listMigrationFiles(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => MIGRATION_RE.test(f));
  const migrations: Migration[] = files.map((f) => {
    const m = MIGRATION_RE.exec(f)!;
    const [, date, time, hash] = m as RegExpExecArray;
    return {
      file: f,
      hash: hash!,
      sortKey: `${date!}${time!}`,
      sqlText: readFileSync(join(dir, f), "utf8"),
    };
  });
  migrations.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return migrations;
}

// Hashes already recorded in __singularity_migrations (the applied-state ledger).
// Creates the ledger table if absent, so callers can use the result directly.
async function getAppliedHashes(db: NodePgDatabase | Tx): Promise<Set<string>> {
  await db.execute(drizzleSql`
    CREATE TABLE IF NOT EXISTS ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)} (
      hash text PRIMARY KEY,
      file text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = await executeRows(db, {
    query: drizzleSql`SELECT hash FROM ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)}`,
    row: z.object({ hash: z.string() }),
    label: "migrations: read applied ledger",
  });
  return new Set(applied.map((r) => r.hash));
}

// PURE (exported for unit testing): given the ordered migration list and the
// hashes already in the ledger, decide which to apply and which to skip as
// same-run duplicate-hash siblings. Mutates nothing.
//
// WHY skip-by-hash is correct: the ledger (__singularity_migrations) keys applied
// state by the filename sha8, which is its PRIMARY KEY. Two files carrying the
// same sha8 are byte-identical content (e.g. a `CREATE TABLE IF NOT EXISTS` that
// legitimately recurs in schema history after an add then later remove). The
// first occurrence applies and records its hash; the second carries the SAME
// content, so re-running it would (a) be a no-op for the identical DDL and
// (b) attempt a duplicate INSERT of the same PK → unique-constraint violation.
// We therefore apply the first and skip the rest — but loudly (see callers),
// never silently.
export function planMigrations(
  migrations: Migration[],
  appliedHashes: ReadonlySet<string>,
): {
  toApply: Migration[];
  skippedDuplicates: { file: string; original: string }[];
} {
  const toApply: Migration[] = [];
  const skippedDuplicates: { file: string; original: string }[] = [];
  // hash → first file in THIS list that we plan to apply for that hash.
  const firstFileForHash = new Map<string, string>();

  for (const m of migrations) {
    if (firstFileForHash.has(m.hash)) {
      // A same-run sibling: an earlier file in this list already owns this hash.
      // Identical content; skipping the second is a no-op (and avoids a
      // duplicate-PK INSERT). Reported loudly by the caller.
      skippedDuplicates.push({
        file: m.file,
        original: firstFileForHash.get(m.hash)!,
      });
      continue;
    }
    if (appliedHashes.has(m.hash)) {
      // Normal prior-boot skip: already in the ledger. Not a collision — record
      // it as the owner so a later byte-identical sibling is still recognized as
      // a duplicate of THIS file, but don't re-apply or report it.
      firstFileForHash.set(m.hash, m.file);
      continue;
    }
    firstFileForHash.set(m.hash, m.file);
    toApply.push(m);
  }

  return { toApply, skippedDuplicates };
}

// One unit of work in the boot schema layer, in the order it runs.
//   - `apply` runs SQL: a legacy file whole, or one section of a phased schema
//     migration. An empty section emits no step.
//   - `record` inserts a file's ledger row, right after that file's LAST step —
//     so a phased migration is recorded only at its contract, never after its
//     expand alone, and a phased file with nothing to run still lands its row.
export type SchemaStep =
  | {
      kind: "apply";
      file: string;
      phase: "whole" | "expand" | "contract";
      sql: string;
    }
  | { kind: "record"; file: string; hash: string };

export interface SchemaPlan {
  steps: SchemaStep[];
  // Files with at least one step to run or a ledger row to land.
  pendingFiles: string[];
  skippedDuplicates: { file: string; original: string }[];
}

// PURE (exported for unit testing): the ordered steps that bring a database
// whose ledger holds `appliedHashes` up to `migrations` (timestamp order).
//
// Walks the files in order:
//   - a LEGACY file (no phase header: every schema migration written before the
//     phase grammar, and every data migration) is one step at its own position,
//     so historical replay order is unchanged;
//   - a PHASED schema migration S is one group at its position:
//     S.expand → the data migrations S claims (timestamp order) → S.contract;
//   - a CLAIMED data migration is skipped at its own position (it runs in its
//     claimer's group); an UNCLAIMED one (a data-only push) stays where it is.
// Grouping is per push, never global: phasing every pending migration together
// would break a from-scratch replay (a table one push's contract drops and a
// later push's expand recreates).
//
// Files already in the ledger — and same-run duplicate-hash siblings, exactly as
// `planMigrations` decides — contribute no step. Claims are validated over every
// file on disk, applied or not: a claim naming no file, a file claimed twice,
// and a claim that does not sort before its claimer all THROW, since each would
// otherwise apply a contract before the data it was written to follow.
export function planSchemaSteps(
  migrations: Migration[],
  appliedHashes: ReadonlySet<string>,
): SchemaPlan {
  const { toApply, skippedDuplicates } = planMigrations(
    migrations,
    appliedHashes,
  );
  const pending = new Set(toApply);

  const parsed = new Map(
    migrations.map((m) => {
      try {
        return [m, parseMigration(m.sqlText)] as const;
      } catch (e) {
        throw new Error(`migration ${m.file}: ${(e as Error).message}`);
      }
    }),
  );

  const byClaimId = new Map<string, { m: Migration; index: number }>();
  for (const [index, m] of migrations.entries()) {
    const id = migrationClaimId(m.file);
    const prior = byClaimId.get(id);
    if (prior) {
      throw new Error(
        `migrations ${prior.m.file} and ${m.file} share the claim id "${id}" (same timestamp and slug) — a claim could not tell them apart.`,
      );
    }
    byClaimId.set(id, { m, index });
  }

  // claimed file → its claimer, with every claim validated.
  const claimer = new Map<Migration, Migration>();
  for (const [index, s] of migrations.entries()) {
    const p = parsed.get(s)!;
    if (p.kind !== "phased") continue;
    for (const id of p.claims) {
      const target = byClaimId.get(id);
      if (!target) {
        throw new Error(
          `migration ${s.file} claims "${id}", but no migration file has that timestamp and slug.`,
        );
      }
      if (parsed.get(target.m)!.kind === "phased") {
        throw new Error(
          `migration ${s.file} claims ${target.m.file}, which is a phased schema migration — only data migrations can be claimed.`,
        );
      }
      if (target.index >= index) {
        throw new Error(
          `migration ${s.file} claims ${target.m.file}, which sorts after it — a claimed data migration must sort before its claimer.`,
        );
      }
      const prior = claimer.get(target.m);
      if (prior) {
        throw new Error(
          `migration ${target.m.file} is claimed by both ${prior.file} and ${s.file}.`,
        );
      }
      claimer.set(target.m, s);
    }
  }

  const steps: SchemaStep[] = [];
  const pendingFiles: string[] = [];
  const emitWhole = (m: Migration) => {
    if (!pending.has(m)) return;
    steps.push({ kind: "apply", file: m.file, phase: "whole", sql: m.sqlText });
    steps.push({ kind: "record", file: m.file, hash: m.hash });
    pendingFiles.push(m.file);
  };

  for (const m of migrations) {
    if (claimer.has(m)) continue;
    const p = parsed.get(m)!;
    if (p.kind === "legacy") {
      emitWhole(m);
      continue;
    }
    const own = pending.has(m);
    if (own && p.expand !== "") {
      steps.push({
        kind: "apply",
        file: m.file,
        phase: "expand",
        sql: p.expand,
      });
    }
    // Claims in timestamp order, whatever order the claims section lists them.
    for (const d of migrations) {
      if (claimer.get(d) === m) emitWhole(d);
    }
    if (own) {
      if (p.contract !== "") {
        steps.push({
          kind: "apply",
          file: m.file,
          phase: "contract",
          sql: p.contract,
        });
      }
      steps.push({ kind: "record", file: m.file, hash: m.hash });
      pendingFiles.push(m.file);
    }
  }

  return { steps, pendingFiles, skippedDuplicates };
}

// Everything the boot schema layer derives from source besides the migration
// files. REQUIRED arguments, never read from a registry in here: a process that
// never booted (the `migration-applies-clean` check) would read those empty and
// silently test nothing — the lesson of 1aacd12897. Boot passes the collected
// contributions; the check gathers the same sets from main's server barrels.
export interface SchemaLayerInputs {
  views: readonly DeclaredView[];
  derivedTables: readonly Rollup[];
  updatedAtSpecs: readonly DerivedUpdatedAtSpec[];
}

// Force-rollback sentinel: thrown to abort a non-committing layer so it never
// commits. Distinguished from a real error by identity.
const ROLLBACK = Symbol("schema-layer-rollback");

// Log what the plan says before running it: an applied hash with no file here,
// and every same-run duplicate-hash skip. Both are loud, never silent.
function reportPlan(
  migrations: Migration[],
  appliedHashes: ReadonlySet<string>,
  plan: SchemaPlan,
): void {
  // Applied-but-no-file: a hash recorded as applied with no matching file on
  // this branch. This is EXPECTED when the worktree branch predates a
  // migration that landed on main — the DB was forked from main (or merged it)
  // and already carries that migration's effects, but the branch checkout
  // doesn't have the file yet. It is only real drift if you deleted a migration
  // you authored (rebased it away after it ran here), in which case the DB
  // keeps whatever that migration did. No rollback either way.
  const onDiskHashes = new Set(migrations.map((m) => m.hash));
  for (const h of appliedHashes) {
    if (!onDiskHashes.has(h)) {
      log.publish(
        `[migrate] applied hash ${h} has no file on this branch — expected if this worktree predates a migration that landed on main (the DB already has its effects). Real drift only if you deleted a migration you authored.`,
        "stderr",
      );
    }
  }
  // Identical DDL, so a duplicate skip is a no-op for the DB, but it must never
  // be silent ("fail loudly" rule): a surprise collision means two files share
  // a sha8 and one is being ignored.
  for (const { file, original } of plan.skippedDuplicates) {
    log.publish(
      `[migrate] skipping ${file}: its sha8 hash is byte-identical to ${original}, which is being applied in this run. The ledger PK is the sha8, so re-applying would duplicate-key; the identical DDL makes the skip a no-op.`,
      "stderr",
    );
  }
}

async function runSteps(tx: Tx, steps: readonly SchemaStep[]): Promise<void> {
  for (const step of steps) {
    if (step.kind === "record") {
      await tx.execute(
        drizzleSql`INSERT INTO ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)} (hash, file) VALUES (${step.hash}, ${step.file})`,
      );
      continue;
    }
    const label =
      step.phase === "whole" ? step.file : `${step.file} (${step.phase})`;
    log.publish(`[migrate] applying ${label}`);
    try {
      await tx.execute(drizzleSql.raw(step.sql));
    } catch (e) {
      throw new Error(
        `migration ${label} failed to apply: ${(e as Error).message}`,
        {
          cause: e,
        },
      );
    }
  }
}

// The boot schema layer over an explicit migration list — `applySchemaLayer`
// with the files already read. Exported (not from the barrel) so a DB test can
// apply a synthetic history.
// What one schema-layer run did: how many migration files it applied, and what
// each rollup's reconcile healed (derived-tables). A committing caller
// publishes `rollups` only after the transaction commits (C13): the dry run
// computes them too, and rolls them back.
export interface SchemaLayerResult {
  pending: number;
  rollups: RollupReconcile[];
}

export async function applySchemaLayerFrom(
  db: NodePgDatabase,
  migrations: Migration[],
  inputs: SchemaLayerInputs,
  { commit }: { commit: boolean },
): Promise<SchemaLayerResult> {
  let pending = 0;
  let rollups: RollupReconcile[] = [];
  try {
    await db.transaction(async (tx) => {
      if (!commit) {
        // The dry run replays against the LIVE main DB. statement_timeout is
        // the load-bearing bound on how long it can hold locks there;
        // lock_timeout bounds the wait to ACQUIRE one, so it never queues
        // behind live traffic.
        await tx.execute(drizzleSql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(drizzleSql`SET LOCAL statement_timeout = '60s'`);
      }
      const applied = await getAppliedHashes(tx);
      const plan = planSchemaSteps(migrations, applied);
      reportPlan(migrations, applied, plan);
      pending = plan.pendingFiles.length;

      // Views never block a migration: a live view reading a column a pending
      // migration drops or retypes would fail it. Drop the whole live layer
      // first — only when something is pending, so a steady-state boot opens
      // no lock window — and rebuild it below, in this same transaction.
      if (pending > 0) await dropDerivedViews(tx);
      await runSteps(tx, plan.steps);

      // The derived layer, in dependency order: the updatedAt triggers and the
      // rollup tables need the migrated columns; a view may read a rollup
      // table. Each skips its DDL when unchanged.
      await installDerivedUpdatedAt(tx, inputs.updatedAtSpecs);
      rollups = await rebuildDerivedTables(tx, inputs.derivedTables);
      await rebuildDerivedViews(tx, inputs.views);

      if (!commit) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return { pending, rollups };
}

// The boot schema layer, in ONE transaction:
//   1. if any migration is pending, drop every live public view;
//   2. the pending migrations (`planSchemaSteps`: legacy files whole, each
//      phased schema migration as expand → claimed data → contract), each
//      file's ledger row right after its last step;
//   3. `installDerivedUpdatedAt`, `rebuildDerivedTables`, `rebuildDerivedViews`.
//
// One transaction because the previous backend keeps serving during a hot-swap:
// it waits on this transaction's locks instead of reading missing views, and a
// failure at any step leaves the whole layer — ledger, columns, old views —
// untouched. On a boot with nothing pending, no view is dropped and each derived
// step takes its skip-when-unchanged path, so no new lock window opens.
//
// `commit: false` is the dry run (`dryRunPendingMigrations`): the same code
// under the live-DB timeouts, always rolled back. Only a committing call settles
// `migrationsReady`.
export async function applySchemaLayer(
  db: NodePgDatabase,
  inputs: SchemaLayerInputs,
  { commit }: { commit: boolean },
): Promise<SchemaLayerResult> {
  const run = () =>
    applySchemaLayerFrom(db, listMigrationFiles(MIGRATIONS_DIR), inputs, {
      commit,
    });
  if (!commit) return run();
  try {
    const result = await run();
    resolveMigrationsReady();
    return result;
  } catch (err) {
    rejectMigrationsReady(err);
    throw err;
  }
}

// The migrations alone, with no derived layer, in one transaction — for DB test
// suites that build a throwaway database's tables (`createTestDb` +
// `runMigrations`) and install whatever derived objects they need themselves.
// Boot never calls this: it runs `applySchemaLayer`. Settles nothing.
export async function runMigrations(db: NodePgDatabase): Promise<void> {
  const migrations = listMigrationFiles(MIGRATIONS_DIR);
  await db.transaction(async (tx) => {
    const applied = await getAppliedHashes(tx);
    const plan = planSchemaSteps(migrations, applied);
    reportPlan(migrations, applied, plan);
    await runSteps(tx, plan.steps);
  });
}

// Prove that the pending migrations — and the derived layer main's next boot
// rebuilds after them — apply cleanly on top of the connected DB's current
// state, then ROLL BACK, leaving the DB byte-identical. Used by the
// `migration-applies-clean` check against the live main DB: the only way a
// migration "breaks main" is by erroring during boot's schema layer, and this
// IS that layer (`applySchemaLayer` with `commit: false`), so it cannot drift
// from boot.
//
// Nothing pending ⇒ nothing to verify: returns without opening a transaction,
// so a branch whose migrations main already has never locks main's views.
//
// Note: a rolled-back INSERT still advances any serial/identity sequence
// (nextval is non-transactional), so a dry-run can leave harmless ID gaps. No
// data is changed; this is expected and ignorable.
//
// `inputs` is the derived set main's next boot would install. The caller
// supplies it because this runs in a process that never booted, where no
// contribution was collected and no schema file was loaded.
export async function dryRunPendingMigrations(
  db: NodePgDatabase,
  inputs: SchemaLayerInputs,
): Promise<{ pending: number }> {
  const applied = await getAppliedHashes(db);
  const { pendingFiles } = planSchemaSteps(
    listMigrationFiles(MIGRATIONS_DIR),
    applied,
  );
  if (pendingFiles.length === 0) return { pending: 0 };
  const { pending } = await applySchemaLayer(db, inputs, { commit: false });
  return { pending };
}
