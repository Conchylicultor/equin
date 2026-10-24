import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgClientBin } from "@plugins/database/plugins/client-tools/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { libpqSubprocessEnv } from "./pool";
import { runDatabaseDdl } from "./database-ddl";
import { databaseExists, dropDatabase } from "./databases";
import { withDbForkSlot } from "./fork-gate";
import { forkTempName } from "./temp-name";
import { describeUndeclaredSchema, resolveForkPlan } from "./fork-plan";
import type { ForkPlan } from "./fork-plan";
import type { ForkExclusions } from "./fork-exclusion";

/**
 * Did this call do the fork, or find it already done?
 *
 * A discriminated result rather than `void` for two reasons: the idempotent
 * no-op is a real outcome a caller may want to say something about, and the
 * plan's findings (schemas nobody claimed, declarations matching nothing) have
 * to reach a surface a human looks at. `forkDatabase` logs them either way; the
 * CLI prints them to the terminal it is running in, and `database/fork`'s job
 * raises the bell.
 */
export type ForkOutcome =
  | { readonly kind: "already-present" }
  | { readonly kind: "forked"; readonly plan: ForkPlan };

// Deliberately NOT the namespace grammar `databases.ts` uses, and deliberately
// not shared with it. A fork's source and target are always MAIN-composition
// namespaces (`singularity` and a checkout's own name), which are single labels
// — a composition's database is created empty by `ensureDatabase`, never forked
// — so the dotted two-label form has no way to arrive here. The temp in between
// never reaches this guard either: `forkTempName` hashes the target to
// `f_<sha8>_<rand8>__forking`, and it is `databases.ts` that validates it.
function assertSafeName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
}

// Forks `source` into `target` atomically and idempotently.
//
// Atomic publish: the fork populates a per-invocation temp DB (unique name from
// forkTempName) and the LAST step renames it to the canonical `<target>`. The
// canonical name therefore only ever exists once the fork fully completed — an
// interrupted fork leaves at most a disposable temp, never a half-baked
// canonical DB.
//
// Lock-free concurrency: each invocation forks its OWN unique temp, so two
// concurrent callers never clobber each other; the final RENAME arbitrates
// (first writer wins, losers drop their temp). No advisory lock or semaphore.
//
// Idempotent: a completed fork (canonical exists) is a no-op. This is the
// precondition that makes durable retry (the `database.fork` job) safe.
//
// `exclusions` is REQUIRED rather than read from the contribution registry here.
// `getContributions()` answers `[]` in any process that never booted the server,
// so a registry read inside this function would make `./equin db fork`
// silently produce a full ~2 GB fork that looks like it worked. A required
// parameter forces every caller to name where its exclusion set came from; see
// `forkExclusions()` in ./fork-exclusion, which fails loudly on the empty case.
// `signal` is optional and ambient (no current caller passes one: the
// `database.fork` job runs detached with no deadline). It cancels the host
// `db-fork` acquire, and once the slot is held it kills whichever of
// dump/restore is running, the temp DB is dropped, and the call throws
// `signal.reason`. That ordering is the point — the temp is reclaimed BEFORE the
// abort is reported, so cancelling a fork never trades a released gate slot for
// a leaked `f_*__forking` database.
export async function forkDatabase(
  source: string,
  target: string,
  exclusions: ForkExclusions,
  signal?: AbortSignal,
): Promise<ForkOutcome> {
  signal?.throwIfAborted();
  assertSafeName(source);
  assertSafeName(target);
  // Canonical name only exists on full completion → already done, no-op.
  if (await databaseExists(target)) return { kind: "already-present" };
  // Turn the DECLARED set into flags by matching it against the SOURCE
  // database's own catalog (./fork-plan), which is also where the declarations
  // get checked against what is actually there — a pattern claimed by two
  // contributions, a `keep` naming no table, a schema nobody claimed at all.
  //
  // Before `CREATE DATABASE temp`, deliberately: the two states ./fork-plan
  // refuses outright must leave no temp behind to sweep.
  const plan = await resolveForkPlan(source, exclusions);
  // Both of these are findings, not failures — see ForkPlan for why neither may
  // stop a fork. They are logged here so EVERY path says them once, and handed
  // back so the caller that has a human (the CLI) or a bell (the fork job) can
  // put them where that human will actually see them.
  for (const line of plan.unmatched) {
    console.warn(`[db-fork] declared exclusion matches nothing: ${line}`);
  }
  for (const s of plan.undeclaredSchemas) {
    console.warn(`[db-fork] ${describeUndeclaredSchema(s)}`);
  }
  const temp = forkTempName(target);
  // No stale-temp reap: forkTempName is per-invocation unique, so there is never
  // a stale temp of *our own* name to drop. Orphan reclamation is solely the
  // fork-temp-sweep's job now. Accepted trade-off: a failing target's
  // retries (runAttempts: 5) each mint a fresh temp, so up to ~5 orphan
  // `f_*__forking` DBs can accumulate between the 15-min sweeps — disk cost, not
  // correctness; the sweep's zero-active-connections gate reclaims them.
  // Whole-database DDL (copies the template): the database-DDL bound, not the
  // 60 s default — see ./database-ddl.
  await runDatabaseDdl(
    `fork ${source} → ${target}: CREATE DATABASE ${temp} copies the template database`,
    `CREATE DATABASE "${temp}"`,
  );
  const subprocessEnv = {
    ...process.env,
    ...libpqSubprocessEnv(),
    // The dump/restore CLIENTS are darwinbg-demoted below, but the server-side
    // restore runs in a Postgres backend we cannot demote. Disabling parallel
    // maintenance workers keeps each restore's index builds to one backend, so
    // a fork costs at most one un-demotable core (bounded further by the
    // db-fork gate).
    PGOPTIONS: "-c max_parallel_maintenance_workers=0",
  };
  // What NOT to copy comes from the caller, assembled from the `ExcludeFromFork`
  // / `ExcludeSchemaDataFromFork` contributions each owning plugin declares (see
  // ./fork-exclusion) and resolved against the source catalog above. This file
  // names no consumer table. Every flag is `--exclude-table-data`: a table's DDL
  // is always kept and its rows are always dropped, so nothing outside a schema
  // can dangle and no service is handed a database missing a schema it expects.
  // Between them they take the fork from 2057 MB of mostly observability and
  // mail data down to the ~34 MB a worktree actually reads.
  //
  // Gate ONLY the heavy dump|restore pipeline host-wide (the step whose
  // server-side restore work spawn-priority cannot demote); the cheap admin-pool
  // ops (exists/drop/CREATE/RENAME) stay outside the slot. The
  // clients are additionally darwinbg-demoted (`background: true`) so their own
  // CPU/IO (compression, COPY streaming) yields to the interactive backends.
  //
  // Dump to a FILE, then restore from it — never `pg_dump | pg_restore` through
  // `Bun.spawn` (one child's `stdout` stream handed to the other's `stdin`). Bun
  // relays that pipe through JS, and when `pg_dump` exits it intermittently
  // drops the stream's tail: `pg_dump` exits 0, `pg_restore` fails with "could
  // not read from input file: end of file" mid-`COPY`. Reproduced 6/15 with the
  // real exclusion flags on bun 1.4.2, against 0/15 for the same pair joined by
  // a shell pipe. Two sequential `spawnCaptured` calls hold no JS stream at all.
  await withDbForkSlot(async () => {
    const dir = await mkdtemp(join(tmpdir(), "db-fork-"));
    try {
      const archive = join(dir, "source.dump");
      // A caller's signal bounds the fork when it passes one. None does today:
      // the fork job runs detached with no deadline, and the CLI runs in a
      // terminal, where Ctrl-C is the bound.
      const bound = signal
        ? { signal }
        : {
            unbounded:
              "detached fork job / CLI terminal: nothing shorter than the dump bounds it",
          };
      const opts = { env: subprocessEnv, background: true, ...bound };
      let failure: string | undefined;
      // An abort makes spawnCaptured kill the child and throw `signal.reason`.
      // Reclaim first, report second: the temp is dropped BEFORE that throw
      // leaves this function, so cancelling a fork never leaks an `f_*__forking`.
      try {
        const dump = await spawnCaptured(
          [
            pgClientBin("pg_dump"),
            "-Fc",
            "-f",
            archive,
            ...plan.excludeTableData.map((t) => `--exclude-table-data=${t}`),
            source,
          ],
          opts,
        );
        if (dump.exitCode !== 0) {
          failure = `pg_dump exited ${dump.exitCode ?? dump.signalCode}: ${dump.stderr}`;
        } else {
          const restore = await spawnCaptured(
            [pgClientBin("pg_restore"), "-d", temp, archive],
            opts,
          );
          if (restore.exitCode !== 0) {
            failure = `pg_restore exited ${restore.exitCode ?? restore.signalCode}: ${restore.stderr}`;
          }
        }
      } catch (err) {
        await dropDatabase(temp);
        throw err;
      }
      if (failure !== undefined) {
        await dropDatabase(temp);
        throw new Error(
          `forkDatabase(${source} → ${target}) failed: ${failure}`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, signal);

  // The Graphile Worker schema used to be copied by the dump and then dropped
  // from the temp here, and later excluded outright at dump time. Neither
  // survives: `infra/jobs` now declares it with `keep: ["migrations"]`, so the
  // fork inherits the schema's shape and graphile's migration watermark while
  // its rows (pending jobs, crontab watermarks) stay behind. The forked
  // database is born queue-capable instead of being repaired at first boot.

  // Atomic publish: rename the fully-populated temp to the canonical name as
  // the last step. ALTER DATABASE … RENAME requires no active connections to
  // the temp — the pg_restore connection is gone, and admin connections go
  // direct to Postgres (not through pgbouncer), so nothing blocks the rename.
  //
  // First-writer-wins arbiter: a concurrent caller may have already renamed its
  // own temp to `<target>`, so this RENAME can raise 42P04 (duplicate_database).
  // If the target now exists (dup, or the postcondition recheck — which also
  // covers a tight two-renamer catalog race surfacing as 23505), we are a loser:
  // drop our temp and return; the target is already published. Anything else is
  // a genuine failure (e.g. temp still has live connections) → rethrow loudly.
  try {
    // Waits on the database-object lock (e.g. behind the temp sweep dropping
    // the same temp): the database-DDL bound — see ./database-ddl.
    await runDatabaseDdl(
      `fork ${source} → ${target}: ALTER DATABASE ${temp} RENAME waits on the database lock`,
      `ALTER DATABASE "${temp}" RENAME TO "${target}"`,
    );
  } catch (err) {
    const dup =
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "42P04"; // duplicate_database
    if (dup || (await databaseExists(target))) {
      await dropDatabase(temp); // drop our loser temp; target already published
      return { kind: "already-present" };
    }
    throw err;
  }

  return { kind: "forked", plan };
}
