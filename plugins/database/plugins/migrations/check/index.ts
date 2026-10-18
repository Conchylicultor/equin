import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  MIGRATIONS_DATA_DIR,
  publishedMigrationRefs,
} from "@plugins/database/plugins/migrations/core";
import { dryRunPendingMigrations } from "@plugins/database/plugins/migrations/server";
import {
  listMigrationFiles,
  MIGRATIONS_DIR,
} from "@plugins/database/plugins/migrations/machine";
import { mintTestDbName } from "@plugins/database/plugins/db-test-fixture/core/testing";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { checkoutNamespace } from "@plugins/infra/plugins/paths/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import orphanedTablesCheck from "./orphaned-tables";
import imperativeCreateTableAllowlistedCheck from "./imperative-create-table-allowlisted";
import schemaFilesLoadableCheck from "./internal/schema-files-loadable";
import forkSchemaDriftCheck from "./fork-schema-drift";
import drizzleConfigSchemaGlobsCheck from "./drizzle-config-schema-globs";
import migrationPhasesValidCheck from "./migration-phases-valid";
import publishedMigrationsImmutableCheck from "./published-immutable";
import { withDirectDb } from "./internal/direct-db";
import { declaredSchemaInputs } from "./internal/declared-schema-inputs";

// Wedge-breaker for a metadata-only git read: far above any real duration,
// because starvation under a saturated check run is what these suffer, not
// slowness. Same reasoning as `infra/worktree`'s bounds, which carry the
// measurements.
const GIT_TIMEOUT_MS = 60_000;

// Inlined minimal Check shape (mirrors the other plugin-contributed checks, e.g.
// data-migration-dml-only / migration-hashes-unique) to avoid a cross-plugin
// import of the framework Check type from a check file.
type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  cacheSignature?(): string | null | Promise<string | null>;
};

// WHICH main database. Not a constant: it is the database of the namespace this
// repository's main checkout runs as — `singularity` for the repository this
// machine's main app is served from, and the clone's own namespace for any other
// (a second clone, an e2e's temp repo; `checkoutRef`). Dry-running a clone's
// pending delta against the machine's main database measured a history the
// clone does not share.
async function mainDatabaseOf(root: string): Promise<string> {
  return checkoutNamespace(await getMainRepoRoot(root));
}

async function git(
  root: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  const result = await spawnCaptured(["git", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return { code: result.exitCode, out: result.stdout };
}

// Could not reach main's DB, so the pending migrations were never tried:
// fail loudly rather than pass unverified.
function cannotVerify(database: string, cause: string): CheckResult {
  return {
    ok: false,
    message: `cannot verify migration: main DB ("${database}") not reachable: ${cause}`,
    hint: "The main Postgres cluster must be up to dry-run pending migrations. Start it and re-run the check.",
  };
}

const check: Check = {
  id: "migration-applies-clean",
  description:
    "pending migrations apply cleanly on top of main (transactional dry-run, rolled back)",
  // Impure: reads local `main` via git. The data/ dir CONTENT is already
  // covered by the runner's own tree hash (this check is scope "tree", the
  // default) — only local main's sha needs folding in, since the ref can move
  // without changing anything in this tree.
  async cacheSignature(): Promise<string | null> {
    const [main] = await publishedMigrationRefs(await getWorktreeRoot());
    return main.sha;
  },
  async run() {
    const root = await getWorktreeRoot();

    // FAST PATH: if this branch changes no migration file vs local `main` there
    // is nothing to apply — pass without ever touching the DB. This is the ~99%
    // case (most pushes touch no migration), so it must be free. Local `main`,
    // not a remote's: it is the ref the main DB runs (main auto-builds from
    // it), so it is exactly what the dry-run below would find applied.
    const [main] = await publishedMigrationRefs(root);
    const diff = await git(root, [
      "diff",
      "--quiet",
      main.sha,
      "--",
      MIGRATIONS_DATA_DIR,
    ]);
    if (diff.code === 0) return { ok: true };

    // SLOW PATH, first the derived layer main's next boot installs after the
    // migrations (views, rollup tables, derived-updatedAt triggers). Read from
    // the server barrels because this process never boots, so no contribution
    // is collected (`getContributions()` throws).
    const declared = await declaredSchemaInputs(root);
    if (!declared.ok) return { ok: false, message: declared.message };

    // Then a migration differs from main → replay the pending delta against
    // main's live DB inside a transaction that always rolls back, over a direct
    // (non-pgbouncer) connection so the multi-statement dry-run transaction
    // stays on one backend. withDirectDb separates a connectivity failure
    // (cannot verify → fail loudly) from a real apply failure (the migration is
    // broken), which is reported from inside the callback.
    const database = await mainDatabaseOf(root);
    const dryRun = async (pool: Pool): Promise<CheckResult> => {
      try {
        await dryRunPendingMigrations(
          drizzle(pool),
          listMigrationFiles(MIGRATIONS_DIR),
          declared.inputs,
        );
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          message: (e as Error).message,
          hint: "This migration (or the derived layer after it: updatedAt triggers, rollup tables, views) would fail and crash main's boot. Fix the SQL in plugins/database/plugins/migrations/data/, or the derived object in its owning plugin.",
        };
      }
    };
    const result = await withDirectDb(database, dryRun);
    switch (result.kind) {
      case "ok":
        return result.value;
      case "unreachable":
        return cannotVerify(database, result.cause);
      case "no-database":
        // This machine's main app always has its database: a missing one is
        // no more verifiable than an unreachable cluster.
        if (database === MAIN_WORKTREE_NAME)
          return cannotVerify(
            database,
            `database "${database}" does not exist`,
          );
        // Another repository whose main was never deployed here: there is no
        // live data for a migration to trip on, so the whole truth is the
        // schema — every migration, main's and this branch's, applied in order
        // to an empty database.
        return schemaOnlyDryRun(database, dryRun);
    }
  },
};

/**
 * The dry-run on a throwaway empty database, for a repository with no deployed
 * main on this machine. The name is minted in the disposable test-database
 * grammar, so the test-db sweep reclaims it if this process dies before the
 * `finally`. A failure says which mode ran, so a pass is never mistaken for a
 * check against live data.
 */
async function schemaOnlyDryRun(
  mainDatabase: string,
  dryRun: (pool: Pool) => Promise<CheckResult>,
): Promise<CheckResult> {
  const scratch = mintTestDbName("mig_check", process.pid, Date.now());
  // Over the maintenance database, directly: `database/admin`'s pool throws at
  // import in a check subprocess (see ./internal/direct-db.ts). The name comes
  // from `mintTestDbName`'s own grammar, so it is safe to quote as an identifier.
  const created = await withDirectDb("postgres", (pool) =>
    pool.query(`CREATE DATABASE "${scratch}"`),
  );
  if (created.kind !== "ok")
    return cannotVerify(
      scratch,
      created.kind === "unreachable"
        ? created.cause
        : "maintenance database missing",
    );
  try {
    return await verdictOnScratch(scratch, mainDatabase, dryRun);
  } finally {
    const dropped = await withDirectDb("postgres", (pool) =>
      pool.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`),
    );
    // Loud: a scratch database left behind is the sweep's backstop, not silence.
    if (dropped.kind !== "ok")
      console.warn(
        `migration-applies-clean: could not drop scratch database "${scratch}" (${dropped.kind}); the test-db sweep reclaims it.`,
      );
  }
}

async function verdictOnScratch(
  scratch: string,
  mainDatabase: string,
  dryRun: (pool: Pool) => Promise<CheckResult>,
): Promise<CheckResult> {
  const result = await withDirectDb(scratch, dryRun);
  switch (result.kind) {
    case "ok":
      return result.value.ok
        ? result.value
        : {
            ...result.value,
            message: `schema-only (no deployed main "${mainDatabase}" on this machine): ${result.value.message}`,
          };
    case "unreachable":
      return cannotVerify(scratch, result.cause);
    case "no-database":
      throw new Error(
        `migration-applies-clean: scratch database "${scratch}" vanished right after it was created`,
      );
  }
}

export default [
  check,
  orphanedTablesCheck,
  imperativeCreateTableAllowlistedCheck,
  schemaFilesLoadableCheck,
  forkSchemaDriftCheck,
  drizzleConfigSchemaGlobsCheck,
  migrationPhasesValidCheck,
  publishedMigrationsImmutableCheck,
];
