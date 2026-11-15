import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import { codegenPassOver } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  dryRunTarget,
  migrationShadowName,
  MIGRATIONS_DATA_DIR,
  publishedMigrationRefs,
  type DryRunTarget,
} from "@plugins/database/plugins/migrations/core";
import { queryOne } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";
import { dryRunPendingMigrations } from "@plugins/database/plugins/migrations/server";
import {
  listMigrationFiles,
  MIGRATIONS_DIR,
} from "@plugins/database/plugins/migrations/machine";
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
import { provideHostServicesUnbooted } from "@plugins/framework/plugins/server-core/core";
import {
  LogPersistence,
  type LogPersistenceImpl,
} from "@plugins/primitives/plugins/log-channels/server";
import { withDirectDb } from "./internal/direct-db";
import { declaredSchemaInputs } from "./internal/declared-schema-inputs";
import {
  ensureMigrationShadow,
  reapOtherShadows,
} from "./internal/migration-shadow";

// Wedge-breaker for a metadata-only git read: far above any real duration,
// because starvation under a saturated check run is what these suffer, not
// slowness. Same reasoning as `infra/worktree`'s bounds, which carry the
// measurements.
const GIT_TIMEOUT_MS = 60_000;

/** Log persistence for the dry-run: nothing past each channel's own ring. */
const RING_ONLY_LOGS: LogPersistenceImpl = {
  sinkFor: () => ({ appendAll: () => Promise.resolve() }),
  clientSinkFor: () => ({ appendAll: () => Promise.resolve() }),
  clientIngressPaused: () => false,
};

// Inlined minimal Check shape (mirrors the other plugin-contributed checks, e.g.
// data-migration-dml-only / migration-hashes-unique) to avoid a cross-plugin
// import of the framework Check type from a check file.
type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(ctx: CheckContext): Promise<CheckResult>;
  cacheSignature?(): string | null | Promise<string | null>;
};

// WHICH main database. Not a constant: it is the database of the namespace this
// repository's main checkout runs as — the main namespace for the repository this
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
    "pending migrations apply cleanly on top of main (transactional dry-run in a fork of main, rolled back)",
  // Impure: reads local `main` via git. The data/ dir CONTENT is already
  // covered by the runner's own tree hash (this check is scope "tree", the
  // default) — only local main's sha needs folding in, since the ref can move
  // without changing anything in this tree.
  async cacheSignature(): Promise<string | null> {
    const [main] = await publishedMigrationRefs(await getWorktreeRoot());
    return main.sha;
  },
  async run(ctx) {
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
    const declared = await declaredSchemaInputs(
      codegenPassOver(await ctx.repo()),
    );
    if (!declared.ok) return { ok: false, message: declared.message };

    // Then a migration differs from main → replay the pending delta inside a
    // transaction that always rolls back — in a MIGRATION SHADOW (a fork of
    // main's database: its real schema and rows), never in main itself. A
    // rolled-back dry run still holds every lock its migrations take until it
    // ends, and in main that queued main's own readers behind every branch's
    // check pass (./internal/migration-shadow.ts). Over a direct
    // (non-pgbouncer) connection so the multi-statement transaction stays on
    // one backend. withDirectDb separates a connectivity failure (cannot verify
    // → fail loudly) from a real apply failure (the migration is broken),
    // which is reported from inside the callback.
    const database = await mainDatabaseOf(root);
    // The dry-run replays the derived layer, whose rebuilds log to durable
    // channels — and a durable channel's store is a host service, which this
    // process (a host that never boots its graph) must name itself, or the
    // first log line throws and reads as a broken migration. Its lines stay in
    // the channel's ring: a dry-run's log is not worth keeping.
    provideHostServicesUnbooted([LogPersistence.provide(RING_ONLY_LOGS)]);
    const dryRun =
      (target: DryRunTarget) =>
      async (pool: Pool): Promise<CheckResult> => {
        try {
          await dryRunPendingMigrations(
            drizzle(pool),
            target,
            await listMigrationFiles(MIGRATIONS_DIR),
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

    // Does main's database exist? Asked of the maintenance database, so the
    // check opens no session on main at all.
    const probe = await withDirectDb("postgres", (pool) =>
      queryOne(pool, {
        sql: "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
        params: [database],
        row: z.object({ present: z.boolean() }),
      }),
    );
    if (probe.kind !== "ok")
      return cannotVerify(
        database,
        probe.kind === "unreachable"
          ? probe.cause
          : "maintenance database missing",
      );
    if (!probe.value.present) {
      // This machine's main app always has its database: a missing one is
      // no more verifiable than an unreachable cluster.
      if (database === MAIN_WORKTREE_NAME)
        return cannotVerify(database, `database "${database}" does not exist`);
      // Another repository whose main was never deployed here: there is no
      // live data for a migration to trip on, so the whole truth is the
      // schema — every migration, main's and this branch's, applied in order
      // to an empty database.
      return schemaOnlyDryRun(database, dryRun);
    }

    const tree = await git(root, [
      "rev-parse",
      `${main.sha}:${MIGRATIONS_DATA_DIR}`,
    ]);
    if (tree.code !== 0)
      return {
        ok: false,
        message: `cannot read the migration tree of local main (${main.sha}:${MIGRATIONS_DATA_DIR})`,
      };
    let shadow: DryRunTarget;
    try {
      shadow = await ensureMigrationShadow({
        mainDatabase: database,
        migrationsTree: tree.out.trim(),
        exclusions: declared.forkExclusions,
      });
    } catch (e) {
      return {
        ok: false,
        message: `cannot verify migration: forking main ("${database}") into a migration shadow failed: ${(e as Error).message}`,
        hint: "The dry run runs in a fork of main, never in main itself. Fix what the fork reports (the same pg_dump | pg_restore every worktree fork runs) and re-run the check.",
      };
    }
    const result = await withDirectDb(shadow.database, dryRun(shadow));
    switch (result.kind) {
      case "ok":
        return result.value;
      case "unreachable":
        return cannotVerify(shadow.database, result.cause);
      case "no-database":
        throw new Error(
          `migration-applies-clean: migration shadow "${shadow.database}" vanished right after it was ensured`,
        );
    }
  },
};

/**
 * The dry-run on a throwaway empty database, for a repository with no deployed
 * main on this machine. It is a migration shadow keyed by this run (the only
 * kind of database a dry run may target), so if this process dies before the
 * `finally`, the next check's reap drops it — its main does not exist. A
 * failure says which mode ran, so a pass is never mistaken for a check against
 * live data.
 */
async function schemaOnlyDryRun(
  mainDatabase: string,
  dryRun: (target: DryRunTarget) => (pool: Pool) => Promise<CheckResult>,
): Promise<CheckResult> {
  const target = dryRunTarget(
    migrationShadowName(
      mainDatabase,
      `scratch:${process.pid}:${Date.now()}:${Math.random()}`,
    ),
  );
  const scratch = target.database;
  await reapOtherShadows(mainDatabase, scratch);
  // Over the maintenance database, directly, like every other connection this
  // check opens itself (./internal/direct-db.ts). The name comes from the
  // shadow grammar (hex and underscores), so it is safe to quote.
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
    return await verdictOnScratch(scratch, mainDatabase, dryRun(target));
  } finally {
    const dropped = await withDirectDb("postgres", (pool) =>
      pool.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`),
    );
    // Loud: a scratch shadow left behind is the next reap's, not silence.
    if (dropped.kind !== "ok")
      console.warn(
        `migration-applies-clean: could not drop scratch shadow "${scratch}" (${dropped.kind}); the next check's reap drops it.`,
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
