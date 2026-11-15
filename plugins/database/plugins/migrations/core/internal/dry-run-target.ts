import { hashHex } from "@plugins/packages/plugins/string-hash/core";

// Where a migration dry run may happen: never in a database something serves.
//
// The dry run (`dryRunPendingMigrations`) executes a branch's pending
// migrations — ALTERs, backfills, index builds, trigger and view rebuilds — in
// a transaction it rolls back. Rolled back is not harmless: for as long as it
// runs it HOLDS every lock those statements take. It used to run inside main's
// live database, from every worktree's check pass, so main's readers queued
// behind a branch's dry run (2026-11-15 03:17 UTC: three conversations_v reads
// on main stalled 11 s until a dry run rolled back).
//
// So the dry run takes a `DryRunTarget`, and the only way to get one names a
// MIGRATION SHADOW (`ms_<sha8(main)>_<sha8(key)>__migshadow`), a database
// nothing serves:
//
//   - a disposable fork of main, its key the published migration tree and the
//     UTC day, shared by every check that dry-runs against the same set that
//     day — main's real data, main's own locks untouched;
//   - for a repository with no deployed main to fork, an empty scratch shadow
//     keyed by the run that created it.
//
// Main's name is not a shadow, so `dryRunTarget("<main>")` throws — and the dry run
// itself re-checks `current_database()` against the target before its first
// statement, so a pool pointed somewhere else fails loudly too.

/** The suffix every migration shadow carries — the whole of "is this one?". */
export const MIGRATION_SHADOW_SUFFIX = "__migshadow";

const SHADOW_RE = /^ms_([0-9a-f]{8})_([0-9a-f]{8})__migshadow$/;

const sha8 = (s: string): string => hashHex(s).slice(0, 8);

/**
 * The shadow of `mainDatabase` under `key`. For a fork of main the key is the
 * git tree id of the migration data dir main runs and the UTC day
 * (`<tree>@<YYYY-MM-DD>`): deterministic, so every check asking the same
 * question finds the same database; the day bounds how stale its rows can get,
 * the tree how stale its schema can get.
 */
export function migrationShadowName(mainDatabase: string, key: string): string {
  return `ms_${sha8(mainDatabase)}_${sha8(key)}${MIGRATION_SHADOW_SUFFIX}`;
}

/**
 * The inverse: which main a shadow belongs to (its sha8), or `null` for a
 * database that is not a shadow. A name ending with the suffix that does not
 * parse is refused — nothing else mints the suffix.
 */
export function parseMigrationShadowName(
  name: string,
): { mainHash: string; keyHash: string } | null {
  if (!name.endsWith(MIGRATION_SHADOW_SUFFIX)) return null;
  const m = SHADOW_RE.exec(name);
  if (!m) {
    throw new Error(
      `Database "${name}" carries the ${MIGRATION_SHADOW_SUFFIX} suffix but does not match ` +
        `ms_<sha8>_<sha8>${MIGRATION_SHADOW_SUFFIX}: nothing else mints it, so its provenance is unknown.`,
    );
  }
  return { mainHash: m[1]!, keyHash: m[2]! };
}

/** The hash a shadow of `mainDatabase` carries for it (`mainHash`). */
export function migrationShadowOwnerHash(mainDatabase: string): string {
  return sha8(mainDatabase);
}

/** Whether `name` is a shadow of `mainDatabase` (any key). */
export function isMigrationShadowOf(
  name: string,
  mainDatabase: string,
): boolean {
  return parseMigrationShadowName(name)?.mainHash === sha8(mainDatabase);
}

declare const dryRunTargetBrand: unique symbol;

/** A database a migration dry run may run in: a migration shadow. */
export type DryRunTarget = {
  readonly database: string;
  readonly [dryRunTargetBrand]: true;
};

/**
 * `database` as a dry-run target — throws for anything but a migration shadow,
 * i.e. for every database a backend serves.
 */
export function dryRunTarget(database: string): DryRunTarget {
  if (parseMigrationShadowName(database) === null) {
    throw new Error(
      `A migration dry run may not run in "${database}": it holds every lock the pending ` +
        `migrations take until it rolls back, so it runs only in a database nothing serves — a ` +
        `migration shadow (${MIGRATION_SHADOW_SUFFIX}).`,
    );
  }
  return { database } as DryRunTarget;
}
