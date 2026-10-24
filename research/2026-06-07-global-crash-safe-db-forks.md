# Crash-safe, self-healing worktree DB forks

## Context

Worktree creation forks the `singularity` database into a per-worktree DB. Today
that fork is **non-atomic and non-durable**, so a backend restart at the wrong
moment permanently bricks a worktree.

`forkDatabase` (`plugins/database/plugins/admin/server/internal/fork.ts`):

1. `CREATE DATABASE "<target>"` — **commits immediately**, so the canonical name
   exists half-baked from the first millisecond.
2. detached `pg_dump | pg_restore` populates it.
3. on error, the catch path runs `dropDatabase` + throws — **but this runs in the
   backend JS process**.

It is called fire-and-forget from `plugins/conversations/server/internal/lifecycle.ts:123`
(`createConversation`). `build`'s `waitForDatabase`
(`plugins/framework/plugins/cli/bin/commands/build.ts:434`) only *polls*
`databaseReady`; it never repairs.

**Observed failure (2026-06-07 16:52 CEST):** a conversation was created at the
exact instant the gateway hot-swapped the main backend. The old backend got
SIGTERM mid-fork; the `pg_dump` COPY was torn down (`could not send data to
client: Broken pipe` → `connection to client lost`); the backend process exited
before step 3 ran, so cleanup never fired. Result: an orphaned empty DB shell
(`CREATE DATABASE` committed, 0 tables, no `__singularity_migrations`). Every
subsequent `./equin build` in that worktree polled for 30s and aborted.
No `db fork failed` log line and no fork-error notification were ever produced —
confirming the cleanup path never executed.

**Intended outcome:** a worktree DB **either fully exists or doesn't, never half**,
and an interrupted fork **self-heals** instead of being terminal.

## Approach

Four changes. The ordering matters: atomicity + idempotency are the *precondition*
that makes durable retry safe — graphile gives you "run it again", not "running it
again is safe". Doing retry without idempotency makes things strictly worse (the
retry hits `CREATE DATABASE … already exists` and gets stuck failing to `dead`).

### 1. Atomic publish — temp-name + rename (`fork.ts`)

Fork into a disposable temp DB, populate it, and make the **last** step an atomic
rename to the canonical name:

```
CREATE DATABASE "<target>__forking"
pg_dump -Fc <source> | pg_restore -d "<target>__forking"
DROP SCHEMA IF EXISTS graphile_worker CASCADE   -- on the temp
ALTER DATABASE "<target>__forking" RENAME TO "<target>"   -- last, only on full success
```

- The canonical name then **only ever exists when the fork fully completed**.
- All interruption debris is confined to disposable `*__forking` temps.
- `ALTER DATABASE … RENAME` requires no active connections to the temp; admin
  connections go **direct** to Postgres (port 5433), not through pgbouncer, and
  the `pg_restore` connection is gone and the graphile-drop pool is `.end()`ed
  before the rename — so no connection blocks it. (This pattern does not exist in
  the codebase yet; we are introducing it.)

### 2. Idempotent `forkDatabase` (`fork.ts`)

Make re-invocation always safe — the precondition for retry:

```ts
export async function forkDatabase(source: string, target: string): Promise<void> {
  assertSafeName(source); assertSafeName(target);
  if (await databaseExists(target)) return;          // canonical => complete => no-op
  const temp = `${target}__forking`;
  await dropDatabase(temp);                            // DROP IF EXISTS WITH FORCE: reap any stale temp
  await getAdminPool().query(`CREATE DATABASE "${temp}"`);
  const subprocessEnv = { ...process.env, ...libpqSubprocessEnv };
  const dump = Bun.spawn(["pg_dump", "-Fc", source], { env: subprocessEnv, stdout: "pipe", stderr: "pipe" });      // NO detached
  const restore = Bun.spawn(["pg_restore", "-d", temp], { env: subprocessEnv, stdin: dump.stdout, stdout: "pipe", stderr: "pipe" }); // NO detached
  const [dumpExit, restoreExit] = await Promise.all([dump.exited, restore.exited]);
  if (dumpExit !== 0 || restoreExit !== 0) {
    const err = await new Response(restore.stderr).text();
    await dropDatabase(temp);
    throw new Error(`forkDatabase(${source} → ${target}) failed: ${err}`);
  }
  const shortPool = openShortLivedClient(temp);
  try { await shortPool.query(`DROP SCHEMA IF EXISTS graphile_worker CASCADE`); }
  finally { await shortPool.end(); }
  await getAdminPool().query(`ALTER DATABASE "${temp}" RENAME TO "${target}"`);
}
```

Reuses existing helpers from the same dir: `databaseExists`, `dropDatabase`
(`internal/databases.ts`), `getAdminPool`, `openShortLivedClient`,
`libpqSubprocessEnv` (`internal/pool.ts`). `forkDatabase` keeps its signature, so
the rename only touches internals.

### 3. Durable retry via a graphile job (the self-healing backstop)

Convert the fork from a fire-and-forget promise into a durable job. The enqueue is
a committed row in graphile-worker; if the worker dies mid-fork, the job is never
marked complete and is **re-run when the backend's worker reboots**.

New file `plugins/database/plugins/admin/server/internal/fork-job.ts`:

```ts
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordNotification } from "@plugins/notifications/server";
import { forkDatabase } from "./fork";

export const databaseForkJob = defineJob({
  name: "database.fork",
  input: z.object({ source: z.string(), target: z.string() }),
  event: z.never(),
  dedup: { key: (i) => i.target },   // jobKey "database.fork:<target>", replace-if-not-running
  maxAttempts: 5,
  run: async ({ input: { source, target } }) => {
    try {
      await forkDatabase(source, target);   // idempotent — safe across retries
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordNotification({
        type: "db", title: "DB fork failed",
        description: `${target}: ${message}`,
        variant: "error", dedupeKey: `fork-error:${target}`,
      });
      throw err;   // rethrow so graphile retries (no-bare-catch compliant)
    }
  },
});
```

Register it in `plugins/database/plugins/admin/server/index.ts` via `register: [databaseForkJob]`.
Export `databaseForkJob` so conversations can enqueue it.

Rewire the call site (`lifecycle.ts`, `createConversation`). Move the enqueue to
*after* `createAttempt` (so the attempt row exists before the job can run) and
await the enqueue (it is just an INSERT, near-instant, and we want it durably
queued):

```ts
// was: void forkDatabase("singularity", thisAttemptId).catch(...)
await createAttempt({ id: thisAttemptId, taskId, worktreePath });
await databaseForkJob.enqueue({ source: "singularity", target: thisAttemptId });
```

The `void forkConfig(thisAttemptId)` line directly below is unrelated and stays.
The old `.catch` + `recordNotification` block is deleted — failure is now surfaced
by the job (notification on each failed attempt, deduped) and observable in
`/api/jobs` (`state: "dead"` once attempts exhaust).

> Durability holds regardless of which backend serves `createConversation`: the
> job row lives in that backend's own DB (main → `singularity`), and that
> backend's worker resumes it after restart. `pg_dump` of `singularity` works from
> any worker. The 60s stuck-lock sweeper (`jobs` plugin) recovers locks from
> unclean crashes.

### 4. Simplify `build`'s readiness check (`build.ts`)

With atomic publish, canonical existence == fork complete, so `databaseReady` no
longer needs the `__singularity_migrations` proxy. Replace the body (and drop the
stale comment at lines 355-360) with an existence check against `pg_database`,
keeping the existing `libpqEnv` + `pg.Client` pattern but connecting to `postgres`:

```ts
const r = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
return (r.rowCount ?? 0) > 0;
```

`waitForDatabase` stays a pure poll (no re-fork trigger needed — graphile is the
backstop). Update its `onDeadline` message to point at `/api/jobs` / the
fork-error notification rather than implying manual recovery, and raise the
deadline 30s → 60s to comfortably cover an early graphile backoff retry.

### 5. Reaper for orphaned temps (`database/admin`)

`*__forking` temps are normally reaped by step 2 (the next fork for that target
drops a stale one). The only lingering case is a temp whose fork job went `dead`
and never retries. Add a new scheduled job (the `worktree-cleanup` plugin has **no**
existing scheduled sweep to extend) in
`plugins/database/plugins/admin/server/internal/fork-temp-sweep.ts`:

```ts
export const forkTempSweepJob = defineJob({
  name: "database.fork-temp-sweep",
  input: z.object({}), event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/15 * * * *" },   // main-only by default (omit perWorktree)
  run: async () => { /* list `*__forking` DBs with zero pg_stat_activity connections; dropDatabase each */ },
});
```

The zero-active-connections guard protects an in-flight fork (its `pg_restore`
holds a connection). Register alongside `databaseForkJob`.

## Critical files

> **Implementation note (2026-06-07):** the two jobs were placed in a **new
> `plugins/database/plugins/fork/` plugin**, not in `database/admin` as originally
> drafted below. `infra/jobs` imports `connectionString` from `database/admin`, so
> a `defineJob` consumer inside `admin` would close an import cycle
> (`database/admin → infra/jobs → database/admin`) — flagged by both boundary
> checks. The `fork` plugin depends on both `infra/jobs` and `database/admin` with
> no edge back, keeping the graph a DAG. `forkDatabase` itself stays in `admin`.

- `plugins/database/plugins/admin/server/internal/fork.ts` — temp+rename, idempotent guard, drop `detached`.
- `plugins/database/plugins/admin/server/internal/databases.ts` — added `countActiveConnections` (used by the sweep); exported from the admin barrel.
- `plugins/database/plugins/fork/server/internal/fork-job.ts` — **new**, `defineJob('database.fork')`.
- `plugins/database/plugins/fork/server/internal/fork-temp-sweep.ts` — **new**, scheduled reaper.
- `plugins/database/plugins/fork/server/index.ts` — **new** barrel, `register: [databaseForkJob, forkTempSweepJob]` + export `databaseForkJob`.
- `plugins/conversations/server/internal/lifecycle.ts` (~123) — enqueue job instead of calling `forkDatabase`; import from `@plugins/database/plugins/fork/server`.
- `plugins/framework/plugins/cli/bin/commands/build.ts` (~355-464) — existence-only `databaseReady`, updated deadline/message.

## Reuse (do not reinvent)

- `defineJob` / `.enqueue` — `plugins/infra/plugins/jobs/server` (dedup via `dedup:{key}`; default maxAttempts 5; exponential backoff; `dead` observable at `/api/jobs`).
- `databaseExists`, `dropDatabase` (`WITH (FORCE)`), `listDatabases` — `internal/databases.ts`.
- `getAdminPool`, `openShortLivedClient`, `libpqSubprocessEnv` — `internal/pool.ts`.
- `recordNotification` — `@plugins/notifications/server`.
- Example jobs to mirror: `attachments.orphan-sweep` (singleton + cron) at `plugins/infra/plugins/attachments/server/internal/orphan-sweep.ts`; keyed-dedup `push_and_exit.exit_clean_finalize` at `…/push-and-exit/server/internal/exit-clean-finalize-job.ts`.

## Verification

1. `./equin build` in this worktree — confirm it still passes with the
   existence-only readiness check (DB already exists).
2. **Happy path:** create a new conversation; `query_db database:singularity`
   → `SELECT * FROM graphile_worker._private_jobs WHERE task_identifier='database.fork'`
   (or `/api/jobs`) shows the job complete; the new worktree DB exists, has
   `__singularity_migrations` rows and no `graphile_worker` schema; no leftover
   `*__forking` DB.
3. **Crash/idempotency:** create a conversation, then immediately
   `pkill -f "pg_restore"` (or restart the enqueuing backend) to kill the fork
   mid-flight. Confirm: no half-baked canonical DB appears; the job retries; the
   worktree DB lands complete; only a transient `*__forking` is observed.
4. **Double-run safety:** manually re-enqueue `database.fork` for an
   already-complete target → job no-ops (canonical exists), no error.
5. **Reaper:** manually `CREATE DATABASE "att-test__forking"` with no connections,
   run the sweep (enqueue `database.fork-temp-sweep`) → temp dropped; repeat while
   holding a connection open → temp preserved.
6. `./equin check` clean (no-bare-catch on the job's rethrow path,
   plugin-boundaries on the new cross-plugin import).
```
