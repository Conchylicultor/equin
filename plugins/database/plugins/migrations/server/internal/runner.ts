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
// The phase grammar by its own file, not through the `core` barrel: the barrel
// also carries the generator's and the checks' filesystem tooling (drizzle-kit
// staging, the published set, the snapshot DAG), and this runner runs on every
// host. Moving that tooling out of `core` is follow-up work (task in the
// portable-split plan's follow-ups).
import {
  migrationClaimId,
  parseMigration,
  type Supersession,
} from "../../core/internal/phases";
import { MIGRATIONS_TABLE_NAME } from "@plugins/database/plugins/derived-views/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";

const log = defineLogSink({
  id: "migrations",
  description:
    "DB migration runner ops log: DDL/data migrations applied on boot — timestamp order, each phased schema migration as one expand → claimed data → contract group.",
});

const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

// The supported way back when this database's state cannot be reconciled with
// the migrations on disk: re-fork it from main. Named by every failure below.
const REFORK_HINT =
  "Re-fork this worktree's database from main with `./equin db fork --replace` (worktree-only data is lost).";

/** Whether `file` is named as a migration (`YYYYMMDD_HHMMSS_<sha8>__<slug>.sql`). */
export function isMigrationFileName(file: string): boolean {
  return MIGRATION_RE.test(file);
}

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

// The migration list from a set of named SQL texts: the files whose name is a
// migration's (`YYYYMMDD_HHMMSS_<sha8>__<slug>.sql`), in timestamp order — the
// order `planSchemaSteps` walks them. Where the texts come from is the host's
// (`MigrationSource`): the desktop reads `data/` off disk.
export function migrationsFrom(
  files: readonly { file: string; sqlText: string }[],
): Migration[] {
  const migrations: Migration[] = [];
  for (const { file, sqlText } of files) {
    const m = MIGRATION_RE.exec(file);
    if (m === null) continue;
    const [, date, time, hash] = m;
    migrations.push({
      file,
      hash: hash!,
      sortKey: `${date!}${time!}`,
      sqlText,
    });
  }
  migrations.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return migrations;
}

// The applied-state ledger (`MIGRATIONS_TABLE_NAME`): hash → the file name it
// was applied under, and the hashes whose contract is still to run (a phased
// file recorded at boot with its contract deferred — see `planSchemaSteps`).
// Creates the table if absent, so callers can use the result directly. Inside
// the schema layer's transaction (`inLayer`) it also adds the
// `contract_pending` column older ledgers lack; the dry run's pre-check, which
// runs against live main outside any transaction, only reads it, treating a
// missing column as nothing pending. Code from before the column reads only
// `hash, file`, so it is unaffected by it.
interface AppliedLedger {
  files: Map<string, string>;
  contractPending: Set<string>;
}

async function getAppliedLedger(
  db: NodePgDatabase | Tx,
  { inLayer }: { inLayer: boolean },
): Promise<AppliedLedger> {
  await db.execute(drizzleSql`
    CREATE TABLE IF NOT EXISTS ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)} (
      hash text PRIMARY KEY,
      file text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  if (inLayer) {
    await db.execute(drizzleSql`
      ALTER TABLE ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)}
        ADD COLUMN IF NOT EXISTS contract_pending boolean NOT NULL DEFAULT false
    `);
  }
  const column = await executeRows(db, {
    query: drizzleSql`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ${MIGRATIONS_TABLE_NAME}
         AND column_name = 'contract_pending'
    ) AS has`,
    row: z.object({ has: z.boolean() }),
    label: "migrations: ledger has contract_pending",
  });
  const applied = await executeRows(db, {
    query:
      column[0]?.has === true
        ? drizzleSql`SELECT hash, file, contract_pending FROM ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)}`
        : drizzleSql`SELECT hash, file, false AS contract_pending FROM ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)}`,
    row: z.object({
      hash: z.string(),
      file: z.string(),
      contract_pending: z.boolean(),
    }),
    label: "migrations: read applied ledger",
  });
  return {
    files: new Map(applied.map((r) => [r.hash, r.file])),
    contractPending: new Set(
      applied.filter((r) => r.contract_pending).map((r) => r.hash),
    ),
  };
}

/**
 * A migration's schema generation: its sha8 read as an unsigned 32-bit
 * number. A process's generation is its LATEST file's — what it holds a
 * shared generation lock on (`DatabaseDriver.holdSchemaGeneration`), so a
 * deferred contract can wait out every process whose code predates it.
 */
export function schemaGeneration(m: Migration): number {
  return Number.parseInt(m.hash, 16);
}

/**
 * The generations that know `file`: its own and every later file's. A
 * process whose latest migration is outside this set runs code from before
 * `file`, which its contract may break.
 */
export function generationsKnowing(
  migrations: readonly Migration[],
  file: string,
): number[] {
  const index = migrations.findIndex((m) => m.file === file);
  if (index < 0) {
    throw new Error(`generationsKnowing: no migration file ${file}`);
  }
  return migrations.slice(index).map(schemaGeneration);
}

// Every hash a lineage names: its direct entries and every inherited one.
function lineageHashes(s: Supersession): Set<string> {
  const all = new Set(s.direct);
  for (const e of s.inherited) {
    all.add(e.hash);
    for (const r of e.replaced) all.add(r);
  }
  return all;
}

// How much of a superseding file's lineage this database applied:
//   - "adopted": every direct entry is covered — in the ledger, or (for a file
//     that was itself replaced before any database applied it) every hash IT
//     replaced is covered. The database already carries the file's delta.
//   - "none": no hash of the lineage is in the ledger: apply the file.
//   - "partial": anything else. Neither applying (it would redo DDL that is
//     there) nor adopting (it would skip DDL that is not) is right.
type LineageState =
  | { kind: "adopted"; via: string[] }
  | { kind: "none" }
  | { kind: "partial"; applied: string[]; uncovered: string[] };

function lineageState(
  s: Supersession,
  appliedHashes: ReadonlySet<string>,
): LineageState {
  const replaced = new Map(s.inherited.map((e) => [e.hash, e.replaced]));
  const covered = (h: string): boolean => {
    if (appliedHashes.has(h)) return true;
    const children = replaced.get(h);
    return children !== undefined && children.every(covered);
  };
  const applied = [...lineageHashes(s)].filter((h) => appliedHashes.has(h));
  if (applied.length === 0) return { kind: "none" };
  const uncovered = s.direct.filter((h) => !covered(h));
  if (uncovered.length === 0) return { kind: "adopted", via: applied };
  return { kind: "partial", applied, uncovered };
}

// PURE (exported for unit testing): given the ordered migration list and the
// hashes already in the ledger, decide which to apply and which to skip as
// same-run duplicate-hash siblings. Mutates nothing.
//
// WHY skip-by-hash is correct: the ledger (`MIGRATIONS_TABLE_NAME`) keys applied
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
//     migration. An empty section emits no step. `reapply` is a claimed data
//     migration run again just before its group's deferred contract.
//   - `record` inserts a file's ledger row, right after that file's LAST step at
//     this run — its contract, or, when the contract is deferred, its claimed
//     data (`contractPending`). A phased file with nothing to run still lands it.
//   - `complete` clears `contract_pending` on the rows whose deferred contract
//     just ran: the file's own and any lineage hash it supersedes.
export type SchemaStep =
  | {
      kind: "apply";
      file: string;
      phase: "whole" | "expand" | "reapply" | "contract";
      sql: string;
    }
  | { kind: "record"; file: string; hash: string; contractPending: boolean }
  | { kind: "complete"; file: string; hashes: string[] };

export interface SchemaPlan {
  steps: SchemaStep[];
  // Files with at least one step to run or a ledger row to land.
  pendingFiles: string[];
  skippedDuplicates: { file: string; original: string }[];
  // Files a lineage this database already applied accounts for: recorded, none
  // of their own SQL run. `by` is the file carrying the lineage (the adopted
  // file itself, or the adoption file naming it); `via` is the lineage hashes
  // found in the ledger.
  adopted: { file: string; via: string[]; by: string }[];
  // Every hash some file on disk supersedes (its whole lineage): a ledger row
  // for one of them has no file here on purpose.
  superseded: ReadonlySet<string>;
  // The phased file whose contract this plan leaves for later
  // (`deferContract`): it is recorded `contract_pending`, and its contract runs
  // once no process older than it is left (`generationsKnowing`). Null when
  // nothing is deferred.
  deferredContract: string | null;
}

export interface SchemaPlanOptions {
  // Ledger hashes whose contract has not run yet (`contract_pending`).
  contractPending?: ReadonlySet<string>;
  // Leave the LAST group's contract for later instead of running it. Only the
  // last: an earlier group's contract must run before a later group's expand
  // (a table one contract drops and a later expand recreates; an FK a later
  // expand adds over a unique index an earlier contract creates). Boot passes
  // true; the dry run, the test helper and the deferred run itself pass false.
  deferContract?: boolean;
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
// A pending phased file with a supersedes header (see `lineageState`) whose
// lineage this database already applied is ADOPTED: its ledger row lands, its
// expand and contract do not run (its claimed data migrations still do, if
// pending). An adoption file (an `adopts` header) extends that to the
// published files it names: a reset whose delta had already landed on main
// regenerated nothing, and those files carry the delta instead. A lineage only
// partly applied THROWS, before any SQL runs, as does an `adopts` naming no
// earlier phased file.
//
// Files already in the ledger — and same-run duplicate-hash siblings, exactly as
// `planMigrations` decides — contribute no step. Claims are validated over every
// file on disk, applied or not: a claim naming no file, a file claimed twice,
// and a claim that does not sort before its claimer all THROW, since each would
// otherwise apply a contract before the data it was written to follow.
//
// THE DEFERRED CONTRACT. A contract is what invalidates the code already
// deployed, and during a hot-swap that code is still serving. So boot
// (`deferContract`) records the last group with its contract pending instead
// of running it; the serving backend runs it once every process older than the
// group is gone (`completeDeferredContract`). A group still pending in the
// ledger (`contractPending`) is completed by any later plan that does not
// defer it: its claimed data migrations run again — the old code kept writing
// rows the backfill did not see — then its contract, then `complete`. Only the
// last group with SQL is ever deferred; a pending earlier one completes inline,
// at its position, before the next group's expand.
export function planSchemaSteps(
  migrations: Migration[],
  appliedHashes: ReadonlySet<string>,
  {
    contractPending = new Set(),
    deferContract = false,
  }: SchemaPlanOptions = {},
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

  // Superseding files whose lineage this database already applied, and the
  // files they adopt. A superseding file adopts itself (its own delta is the
  // lineage's); an adoption file adopts the published files it names, which
  // sort BEFORE it — so every lineage is decided before the walk below.
  const adopted: { file: string; via: string[]; by: string }[] = [];
  const adoptedFiles = new Set<Migration>();
  const superseded = new Set<string>();
  const byHash = new Map(migrations.map((m, index) => [m.hash, { m, index }]));
  for (const [index, m] of migrations.entries()) {
    const p = parsed.get(m)!;
    if (p.kind !== "phased" || p.supersedes === null) continue;
    for (const h of lineageHashes(p.supersedes)) superseded.add(h);
    const targets: Migration[] = [m];
    if (p.adopts.length > 0) {
      targets.length = 0;
      for (const h of p.adopts) {
        const target = byHash.get(h);
        if (!target) {
          throw new Error(
            `migration ${m.file} adopts ${h}, but no migration file has that hash.`,
          );
        }
        const t = parsed.get(target.m)!;
        if (t.kind !== "phased" || t.adopts.length > 0) {
          throw new Error(
            `migration ${m.file} adopts ${target.m.file}, which is not a phased schema migration — only one can be adopted.`,
          );
        }
        if (target.index >= index) {
          throw new Error(
            `migration ${m.file} adopts ${target.m.file}, which sorts after it — an adopted migration must sort before its adoption file.`,
          );
        }
        targets.push(target.m);
      }
    }
    const pendingTargets = targets.filter((t) => pending.has(t));
    if (pendingTargets.length === 0) continue;
    const state = lineageState(p.supersedes, appliedHashes);
    if (state.kind === "partial") {
      throw new Error(
        `migration ${m.file} supersedes ${[...p.supersedes.direct].join(", ")}, but this database applied only part of that lineage ` +
          `(applied: ${state.applied.join(", ")}; not covered: ${state.uncovered.join(", ")}). ` +
          `Applying ${pendingTargets.map((t) => t.file).join(", ")} would redo DDL that is already here, adopting it would skip DDL that is not. ${REFORK_HINT}`,
      );
    }
    if (state.kind === "adopted") {
      for (const t of pendingTargets) {
        if (adoptedFiles.has(t)) continue;
        adopted.push({ file: t.file, via: state.via, by: m.file });
        adoptedFiles.add(t);
      }
    }
  }

  const steps: SchemaStep[] = [];
  const pendingFiles: string[] = [];
  const emitWhole = (m: Migration) => {
    if (!pending.has(m)) return;
    steps.push({ kind: "apply", file: m.file, phase: "whole", sql: m.sqlText });
    steps.push({
      kind: "record",
      file: m.file,
      hash: m.hash,
      contractPending: false,
    });
    pendingFiles.push(m.file);
  };

  // The one group a deferring plan may leave its contract to: the last phased
  // file with SQL of its own (an empty merge node or adoption file after it
  // changes nothing a contract could be ordered against).
  const lastGroup = migrations.findLast((m) => {
    const p = parsed.get(m)!;
    return p.kind === "phased" && (p.expand !== "" || p.contract !== "");
  });

  let deferredContract: string | null = null;
  for (const m of migrations) {
    if (claimer.has(m)) continue;
    const p = parsed.get(m)!;
    if (p.kind === "legacy") {
      emitWhole(m);
      continue;
    }
    const own = pending.has(m);
    const runsSql = own && !adoptedFiles.has(m);
    // Rows still waiting on this group's contract: its own (recorded at an
    // earlier boot) and, for a superseding file, any lineage hash that was.
    const lineagePending =
      p.supersedes === null
        ? []
        : [...lineageHashes(p.supersedes)].filter((h) =>
            contractPending.has(h),
          );
    const ownPending = !own && contractPending.has(m.hash);
    const contractDue =
      p.contract !== "" &&
      (runsSql ||
        ownPending ||
        // Adopted (or already recorded) over a lineage whose contract never ran.
        lineagePending.length > 0);
    if (runsSql && p.expand !== "") {
      steps.push({
        kind: "apply",
        file: m.file,
        phase: "expand",
        sql: p.expand,
      });
    }
    // Claims in timestamp order, whatever order the claims section lists them.
    const claimed = migrations.filter((d) => claimer.get(d) === m);
    for (const d of claimed) emitWhole(d);
    const defer = contractDue && deferContract && m === lastGroup;
    if (defer) deferredContract = m.file;
    if (contractDue && !defer) {
      // Completing a deferred contract: the rows the old code wrote since the
      // claimed data ran at boot. A group run whole in this plan needs none.
      for (const d of own ? [] : claimed) {
        steps.push({
          kind: "apply",
          file: d.file,
          phase: "reapply",
          sql: d.sqlText,
        });
      }
      steps.push({
        kind: "apply",
        file: m.file,
        phase: "contract",
        sql: p.contract,
      });
    }
    if (own) {
      steps.push({
        kind: "record",
        file: m.file,
        hash: m.hash,
        contractPending: defer,
      });
      pendingFiles.push(m.file);
    }
    if (contractDue && !defer) {
      const hashes = [...(ownPending ? [m.hash] : []), ...lineagePending];
      if (hashes.length > 0) {
        steps.push({ kind: "complete", file: m.file, hashes });
        if (!own) pendingFiles.push(m.file);
      }
    }
  }

  return {
    steps,
    pendingFiles,
    skippedDuplicates,
    adopted,
    superseded,
    deferredContract,
  };
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

// Log what the plan says before running it: every adoption, an applied hash
// with no file here that no superseding file accounts for, and every same-run
// duplicate-hash skip. All loud, never silent.
function reportPlan(
  migrations: Migration[],
  ledger: AppliedLedger,
  plan: SchemaPlan,
): void {
  for (const { file, via, by } of plan.adopted) {
    log.publish(
      by === file
        ? `[migrate] adopting ${file}: it supersedes ${via.join(", ")}, already applied here, so it is recorded without running its SQL.`
        : `[migrate] adopting ${file}: ${by} records that ${via.join(", ")}, already applied here, made the same change, so it is recorded without running its SQL.`,
    );
  }
  // A hash a file on disk supersedes is accounted for (`plan.superseded`): the
  // reset that wrote that file deleted the hash's own file on purpose.
  const onDisk = new Set(migrations.map((m) => m.hash));
  // Applied-but-no-file. The runner cannot tell which of two causes it is (it
  // has no git), so it names both rather than calling either one expected:
  //   - the branch is behind main, whose DB this one was forked from: harmless;
  //   - the branch authored the file and rewrote it with no supersedes header:
  //     the DB keeps its effects, and a pending migration that redoes them fails.
  for (const [hash, file] of ledger.files) {
    if (onDisk.has(hash) || plan.superseded.has(hash)) continue;
    log.publish(
      `[migrate] applied migration ${file} (hash ${hash}) has no file on this branch, and no migration here supersedes it` +
        (ledger.contractPending.has(hash)
          ? `, and its contract has not run yet — this code never runs it`
          : "") +
        `. ` +
        `If it is on main and this branch is behind, rebase (\`git rebase origin/main\`). ` +
        `If this branch authored it and later rewrote it, this database keeps its effects, and a pending migration that redoes them will fail to apply — ${REFORK_HINT}`,
      "stderr",
    );
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
  if (plan.deferredContract !== null) {
    log.publish(
      `[migrate] deferring the contract of ${plan.deferredContract}: it runs once no process older than it is left on this database.`,
    );
  }
}

// Plan, report and run the steps on `tx`. A failure — a plan the files refuse
// (a bad claim, a partly applied lineage) or SQL that does not apply — goes to
// the migrations log before it propagates: the process is about to die, and
// its stderr is not where anyone reading this worktree's logs looks.
//
// `dropViews` is the boot layer's: the caller rebuilds the views after.
// `deferContract`: see `SchemaPlanOptions`.
async function planAndRun(
  tx: Tx,
  migrations: Migration[],
  { dropViews, deferContract }: { dropViews: boolean; deferContract: boolean },
): Promise<{ pending: number; deferredContract: string | null }> {
  try {
    const ledger = await getAppliedLedger(tx, { inLayer: true });
    const plan = planSchemaSteps(migrations, new Set(ledger.files.keys()), {
      contractPending: ledger.contractPending,
      deferContract,
    });
    reportPlan(migrations, ledger, plan);
    // Views never block a migration: a live view reading a column a pending
    // migration drops or retypes would fail it. Drop the whole live layer
    // first — only when something is pending, so a steady-state boot opens
    // no lock window — and the caller rebuilds it, in this same transaction.
    if (dropViews && plan.pendingFiles.length > 0) await dropDerivedViews(tx);
    await runSteps(tx, plan.steps);
    return {
      pending: plan.pendingFiles.length,
      deferredContract: plan.deferredContract,
    };
  } catch (e) {
    log.publish(`[migrate] FAILED: ${(e as Error).message}`, "stderr");
    throw e;
  }
}

async function runSteps(tx: Tx, steps: readonly SchemaStep[]): Promise<void> {
  for (const step of steps) {
    if (step.kind === "record") {
      await tx.execute(
        drizzleSql`INSERT INTO ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)} (hash, file, contract_pending) VALUES (${step.hash}, ${step.file}, ${step.contractPending})`,
      );
      continue;
    }
    if (step.kind === "complete") {
      await tx.execute(
        drizzleSql`UPDATE ${drizzleSql.raw(MIGRATIONS_TABLE_NAME)} SET contract_pending = false WHERE hash IN (${drizzleSql.join(
          step.hashes.map((h) => drizzleSql`${h}`),
          drizzleSql`, `,
        )})`,
      );
      log.publish(`[migrate] contract of ${step.file} complete`);
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
// `deferredContract` is the file whose contract this run left for later
// (`completeDeferredContract`), or null.
export interface SchemaLayerResult {
  pending: number;
  rollups: RollupReconcile[];
  deferredContract: string | null;
}

// Serializes committing schema layers on one database: a backend's deferred
// contract and the next deploy's boot layer may overlap, and each plans from
// the ledger it reads — two plans over one ledger would both run a contract.
// A transaction-scoped advisory lock (two-int4 form, so it shares no key with
// the jobs plugin's bigint job locks), released at commit or rollback.
const SCHEMA_LAYER_LOCK = drizzleSql`pg_advisory_xact_lock(1835103859, 0)`;

export async function applySchemaLayerFrom(
  db: NodePgDatabase,
  migrations: Migration[],
  inputs: SchemaLayerInputs,
  { commit, deferContract }: { commit: boolean; deferContract: boolean },
): Promise<SchemaLayerResult> {
  let pending = 0;
  let deferredContract: string | null = null;
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
      } else {
        await tx.execute(drizzleSql`SELECT ${SCHEMA_LAYER_LOCK}`);
      }
      ({ pending, deferredContract } = await planAndRun(tx, migrations, {
        dropViews: true,
        deferContract,
      }));
      if (!commit && deferredContract !== null) {
        // The dry run plays the deferred run too, on the ledger the boot plan
        // just wrote: the claimed data again, then the contract — what the
        // serving backend does once the old code is gone.
        await planAndRun(tx, migrations, {
          dropViews: true,
          deferContract: false,
        });
      }

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
  return { pending, rollups, deferredContract };
}

// The boot schema layer, in ONE transaction:
//   1. if any migration is pending, drop every live public view;
//   2. the pending migrations (`planSchemaSteps`: legacy files whole, each
//      phased schema migration as expand → claimed data → contract), each
//      file's ledger row right after its last step — except the LAST group's
//      contract, which boot defers (`deferContract`): it is what breaks the
//      previous backend's code, still serving. `completeDeferredContract` runs
//      it once that code is gone;
//   3. `installDerivedUpdatedAt`, `rebuildDerivedTables`, `rebuildDerivedViews`.
//
// One transaction because the previous backend keeps serving during a hot-swap:
// it waits on this transaction's locks instead of reading missing views, and a
// failure at any step leaves the whole layer — ledger, columns, old views —
// untouched. On a boot with nothing pending, no view is dropped and each derived
// step takes its skip-when-unchanged path, so no new lock window opens.
//
// `commit: false` is the dry run (`dryRunPendingMigrations`): the same code
// under the live-DB timeouts, always rolled back, contract included. Only a
// committing call settles `migrationsReady`.
export async function applySchemaLayer(
  db: NodePgDatabase,
  migrations: Migration[],
  inputs: SchemaLayerInputs,
  { commit, deferContract }: { commit: boolean; deferContract: boolean },
): Promise<SchemaLayerResult> {
  const run = () =>
    applySchemaLayerFrom(db, migrations, inputs, { commit, deferContract });
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
export async function runMigrations(
  db: NodePgDatabase,
  migrations: Migration[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await planAndRun(tx, migrations, {
      dropViews: false,
      deferContract: false,
    });
  });
}

// Run the contract boot deferred (`SchemaLayerResult.deferredContract`), once
// the caller has waited out every process older than it
// (`DatabaseDriver.awaitGenerationsGone`): the schema layer again, deferring
// nothing, so it re-runs the group's claimed data migrations (the rows the old
// code wrote since boot), runs the contract, clears `contract_pending`, and
// rebuilds the derived layer — one transaction, serialized with any other
// schema layer on this database. A later deploy's boot that already completed
// it leaves nothing to do here.
export async function completeDeferredContract(
  db: NodePgDatabase,
  migrations: Migration[],
  inputs: SchemaLayerInputs,
): Promise<SchemaLayerResult> {
  return applySchemaLayerFrom(db, migrations, inputs, {
    commit: true,
    deferContract: false,
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
  migrations: Migration[],
  inputs: SchemaLayerInputs,
): Promise<{ pending: number }> {
  const ledger = await getAppliedLedger(db, { inLayer: false });
  const { pendingFiles } = planSchemaSteps(
    migrations,
    new Set(ledger.files.keys()),
    { contractPending: ledger.contractPending },
  );
  if (pendingFiles.length === 0) return { pending: 0 };
  // Boot's plan, then the deferred run (see `applySchemaLayerFrom`): the
  // contract still gets proved, and the claimed data, which runs at boot and
  // again before the contract, gets proved idempotent.
  const { pending } = await applySchemaLayer(db, migrations, inputs, {
    commit: false,
    deferContract: true,
  });
  return { pending };
}
