import {
  databaseExists,
  dropDatabaseIfIdle,
  forkDatabase,
  listDatabases,
  type ForkExclusions,
} from "@plugins/database/plugins/admin/server";
import {
  dryRunTarget,
  isMigrationShadowOf,
  migrationShadowName,
  migrationShadowOwnerHash,
  parseMigrationShadowName,
  type DryRunTarget,
} from "@plugins/database/plugins/migrations/core";

// The migration shadow: where `migration-applies-clean` dry-runs a branch's
// pending migrations instead of main's live database.
//
// A dry run is rolled back, but for as long as it runs it holds every lock its
// migrations take (an ALTER's ACCESS EXCLUSIVE, a backfill's row locks, a
// trigger or view rebuild), and every reader of those tables queues behind it
// — and behind ITS queued lock request, which is how a 1 s `lock_timeout` wait
// stalls readers too. In main, that was every branch's check pass.
//
// The shadow is a fork of main (`forkDatabase`, the same pg_dump | pg_restore
// every worktree fork is, minus the same declared exclusions), so it holds
// main's real schema and rows; main pays what any fork costs it — ACCESS SHARE
// on its tables for the length of the dump, which no reader waits on (only DDL:
// main's own boot layer if it deploys mid-dump, as with every worktree fork,
// ~107 a day). It is
// SHARED: its name is a function of main's database, the migration tree main
// runs and the UTC day (`migrationShadowName`), so every check that asks the
// same question on the same day finds the one already minted. Measured
// 2026-11-15: a fork of main takes 16 s p50 / 33 s p90, ~7 migration commits
// land on main a day, so the shadow is minted a handful of times a day while
// a slow-path check pass (one whose branch changes a migration) costs one fork
// at most, usually none.
//
// Concurrent dry runs in one shadow are serialized by the schema-layer lock
// the dry run takes (`applySchemaLayerFrom`); concurrent mints are arbitrated
// by `forkDatabase`'s own atomic publish (the loser drops its temp).

/** Today in UTC, as the shadow key's day: `YYYY-MM-DD`. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The shadow of `mainDatabase` for `migrationsTree` (the git tree id of the
 * migration data dir at local `main`), forked now if it is not there yet; then
 * every other shadow of the same main that no session is using is dropped.
 */
export async function ensureMigrationShadow(opts: {
  mainDatabase: string;
  migrationsTree: string;
  exclusions: ForkExclusions;
  now?: Date;
}): Promise<DryRunTarget> {
  const name = migrationShadowName(
    opts.mainDatabase,
    `${opts.migrationsTree}@${utcDay(opts.now ?? new Date())}`,
  );
  const target = dryRunTarget(name);
  if (!(await databaseExists(name))) {
    await forkDatabase(opts.mainDatabase, name, opts.exclusions);
  }
  await reapOtherShadows(opts.mainDatabase, name);
  return target;
}

/**
 * Drop every migration shadow nobody is using that is not `current` and either
 * belongs to `mainDatabase` or to a main that no longer exists. A shadow of an
 * older migration set or day is never read again, nor is the scratch shadow of
 * a schema-only run that died before dropping it (a temp repository's, whose
 * main never existed). Dropped only when idle: a check still dry-running in one
 * keeps it until a later reap.
 */
export async function reapOtherShadows(
  mainDatabase: string,
  current: string,
): Promise<void> {
  const databases = await listDatabases();
  const owners = new Set(databases.map(migrationShadowOwnerHash));
  for (const db of databases) {
    const shadow = parseMigrationShadowName(db);
    if (db === current || shadow === null) continue;
    if (!isMigrationShadowOf(db, mainDatabase) && owners.has(shadow.mainHash))
      continue;
    const outcome = await dropDatabaseIfIdle({
      unserved: db,
      reason:
        "a superseded or orphaned migration shadow: only migration-applies-clean dry runs connect to one",
    });
    if (outcome === "in-use")
      console.warn(
        `migration-applies-clean: superseded migration shadow "${db}" is in use; a later reap drops it.`,
      );
  }
}
