# A check's DB connect timeout aborts the whole check run

## Context

On 2026-09-10/11, `./equin build` / `check` failed on every branch that was
behind main's destructive migrations (e.g. "remove the Workflows and Story apps").
The transcript only said `run aborted: Error: Connection terminated due to
connection timeout`. It didn't say which check failed, or why, and it never
showed the check's own "rebase onto main" hint.

There were two problems:

1. When one check throws, the whole run stops. You don't learn which check threw.
2. It was unclear why a direct connection to a healthy Postgres timed out after 5 s.

## What actually happened (diagnosis)

**Which check threw.** The run's progress log
(`~/.singularity/logs/check-progress/check-progress.jsonl*`) records
`fork-schema-drift` ending `ok:false` a few ms before the `done` record in every
aborted run: gdze `15c328050-1789077563056`, qmxf `ca6607f05-1789077145528` /
`…081495477` / `…083967017`, and sy2h. Its connect error has no `.code`, so the
check rethrows it (`fork-schema-drift.ts:142`). The rethrow reaches the runner's
`Promise.all` catch (`runner.ts:695`), which ends the run.

**Why 5 s ran out. The cause is the check process, not Postgres.**

- Postgres has run without a restart since 2026-09-10 01:04. Its log and
  pgbouncer's log show no connection errors in the window. Auth is `trust`, so
  there is no password handshake to wait on.
- A full check pass starts ~100 checks at once in one process, and they all
  share one JS thread. For the first 8–16 s of every failing run, **not even the
  most trivial check finished**. The fastest check in each run was
  `icon-svg-map-in-sync`, at 7.5 s, 12.5 s, 13.2 s and 15.7 s. So that thread was
  saturated.
- The 5 s connect timer counts real clock time on that busy thread. Postgres
  answers in milliseconds, but the process can't read the answer before its own
  timer fires.
- Near-proof: in all four gdze/qmxf runs, `orphaned-db-tables` opened the same
  kind of direct connection to the same worktree DB and succeeded. It finished
  60–160 ms after `fork-schema-drift` failed. The only difference is that it has
  no connect timeout.
- Host load was high (28 on 18 CPUs, a duress band from 23:54 to 23:58 CEST). That
  makes the saturation worse, but it isn't the mechanism.

The uvws runs (`1b5be086d…`) show an older, worse version of the same thing.
That branch predates `92e671676`, which moved type-check's preparation off the
main thread (see `research/2026-09-10-tooling-type-check-prepare-off-thread.md`).
There, type-check froze the thread for ~180 s, and `migration-applies-clean`
also got `ECONNREFUSED`. That doc explains that mechanism: Postgres drops a
connection that sends nothing for 60 s.

So the direct (non-pgbouncer) path is configured correctly. The bug is a
wall-clock timeout shorter than how long the thread it runs on can stay busy.

**The class.** Three checks in `plugins/database/plugins/migrations/check/` each
build their own direct `Pool`, with three different timeouts and three different
ways of handling a failed connect:

| check | connect timeout | on connect failure |
|---|---|---|
| `fork-schema-drift` | 5 s | rethrows → aborts the run |
| `orphaned-db-tables` | none (can hang forever) | bare `catch` → `{ok:true}` |
| `migration-applies-clean` | none (can hang forever) | fatal "main DB not reachable" |

## Plan

### Part 1: a check that throws fails itself, not the run

**File:** `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`. This
is a framework file, so the change needs the user's approval, which this plan
asks for.

- In the gate callback (`runner.ts:643`), catch any error thrown by `runOne`
  and turn it into that check's own failed result. Don't let it reject
  `Promise.all`. The result is fatal and never cached (only passes are cached):
  - message: `threw instead of returning a result:\n<err.stack>`
  - hint: an uncaught throw is a bug in the check. It should return
    `{ ok: false }` (or `inconclusive`) for any failure it can name. The other
    checks in this run still ran.
- Put the conversion in a small pure helper, `thrownOutcome(check, err, …)`, in
  a new `core/thrown-outcome.ts`, so it can be unit-tested without loading the
  generated check registry. Create the `observations` buffer before `runOne` and
  pass it in, so anything a check logged before throwing is kept.
- The progress `end` record and the transcript entry then come from the normal
  settle path (`runner.ts:666-686`). The transcript names the check and holds
  the full stack. The console prints `• fork-schema-drift ... FAIL` followed by
  the message and hint, like any other failure.
- Keep the outer `Promise.all` catch. It now fires only for runner-internal
  failures. As a side effect, the transcript can no longer get entries written
  after its `done` line, which happened today because checks kept settling
  after the abort.

Failures stay loud: the run still fails, the check is named, and the stack is
kept. The only thing lost is the collateral damage of hiding every other
check's verdict.

### Part 2: one connection helper for the three migration checks

**New file:** `plugins/database/plugins/migrations/check/internal/direct-db.ts`.
It is private to this `check/` folder, and all three consumers already live there.

```ts
export type DirectDbResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "unreachable"; cause: string } // could not open a connection
  | { kind: "no-database" };               // 3D000: worktree DB never forked

export async function withDirectDb<T>(
  database: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<DirectDbResult<T>>;
```

- It owns the pool: `buildConnectionString(readDatabaseConfig().connection, database)`,
  `max: 1`, `idleTimeoutMillis: 1_000`, and the idle-error listener
  (`fork-schema-drift.ts:125`). It closes the pool in `finally`.
- **"Unreachable" means one specific step failed.** The helper opens and
  releases one client before calling `fn`. Any error from that step is
  `unreachable` (or `no-database` for 3D000). Errors thrown by `fn` itself
  propagate unchanged: the query is what the check is about. No guessing from
  error codes. This is the same probe `migration-applies-clean` already uses.
- **One connect timeout, `DIRECT_CONNECT_TIMEOUT_MS = 60_000`.** The comment on
  it will say why: the timer counts real time on the check process's own
  thread, which a full pass keeps busy for 8–16 s. 60 s equals Postgres's own
  `authentication_timeout`, so a longer client timeout gains nothing (the
  server has already dropped the connection by then). It also gives the two
  checks that have no bound today one.
- `cause` includes the pg message and the elapsed milliseconds, so a timeout
  reads as what it was.

Each check must handle every arm of the result. The type forces an explicit
choice per check:

- **`fork-schema-drift`**: `no-database` → pass (unchanged). `unreachable` →
  **fatal FAIL** that leads with what is already known without the DB:
  > Could not read this worktree's migration ledger (DB "<wt>"): <cause>.
  > main has N destructive migration(s) this branch lacks. If this DB applied
  > them, your code may use schema they drop: <list>
  >
  > hint: Rebase onto main. That clears this check with or without the DB:
  > `git fetch origin main && git rebase origin/main`

  It stays fatal rather than `inconclusive`: letting the build continue would
  restart the server on a DB missing schema the code still uses, and the rebase
  is a cheap, certain fix. `42P01` (no ledger table) stays an empty applied set
  inside `fn`, as today.
- **`orphaned-db-tables`**: `unreachable` / `no-database` → `{ok:true}`. Same
  behaviour as today (its comment explains why "cannot look" must never block
  push). The bare `catch` and its lint-disable go away.
- **`migration-applies-clean`**: `unreachable` → the existing fatal "main DB not
  reachable" result, with the same text and hint. `drizzle(pool)` runs inside
  `fn`, and the existing apply-error catch stays inside `fn`.

### Out of scope → file as a follow-up task (`add_task`) after approval

**What keeps the check thread busy for 8–16 s at the start of every full pass.**
This is the follow-up proposed in the type-check off-thread doc: a runner-level
event-loop stall detector. It would name the checks running whenever the
thread stalls for more than a few seconds. The 60 s timeout removes this
failure, but not the slowness that caused it.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` (framework, needs approval)
- `plugins/framework/plugins/tooling/plugins/checks/core/thrown-outcome.ts` (new) + test
- `plugins/database/plugins/migrations/check/internal/direct-db.ts` (new) + test
- `plugins/database/plugins/migrations/check/fork-schema-drift.ts`
- `plugins/database/plugins/migrations/check/orphaned-tables.ts`
- `plugins/database/plugins/migrations/check/index.ts` (`migration-applies-clean`)
- `plugins/database/plugins/migrations/CLAUDE.md`: one paragraph ("Direct DB
  connections from checks go through `withDirectDb`") next to "Checks run
  BEFORE migrations apply"
- `plugins/framework/plugins/tooling/plugins/checks/CLAUDE.md`: one paragraph
  stating that a check which throws fails itself and never aborts the run

Reused: `buildConnectionString` / `readDatabaseConfig` (`plugins/database/core`),
`queryRows` (`sql-rows/core`), `classifyMigrationSql`, and the probe pattern at
`migrations/check/index.ts:118-127`.

## Verification

1. **Unit tests.**
   - `thrownOutcome`: a thrown `Error` gives `ok:false`, the stack is in the
     message, it isn't cached, and the observations are kept. A thrown
     non-`Error` value is stringified.
   - `withDirectDb`:
     - `unreachable` for a socket dir that doesn't exist (no DB needed)
     - `no-database` for a random DB name on the live cluster
     - `ok` for `SELECT 1` against `singularity`
     - an error thrown inside `fn` propagates rather than being classified

   Run with `./equin test plugins/framework/plugins/tooling/plugins/checks`
   and `./equin test plugins/database/plugins/migrations`.
2. **Reproduce the mechanism.** A throwaway script in the scratchpad, run with
   `./equin run`. In one process: start a direct connect, then block the
   thread for 8 s with sync work.
   - With the old pool options (5 s): "Connection terminated due to connection
     timeout", against a healthy Postgres.
   - Through `withDirectDb`: `ok`.
3. **Full pass.** `./equin check`, then `./equin build` in the
   background. `build-status.json` should show `status: ok`, and all three
   migration checks should be green.
