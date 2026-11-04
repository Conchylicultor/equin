# Database connection failures: a failure must clean up after itself, and say so

Status: incident fixed on main; first fix (awake-time deadline) and an interim
backstop landed with this doc; the rest is proposed tasks below.

## The incident (2026-11-03 → 04, main)

`http://equin.localhost:9000/home` sat on "Waiting for the server…" for about
five hours.

| Local time | Evidence | Meaning |
|---|---|---|
| 20:02:13 | `pg_stat_activity.xact_start` of pid 87346 | a `conversations.usage:sync` transaction opens (`plugins/conversations/plugins/usage/machine/internal/sync.ts`: upsert `conversation_usage_files`, then `conversations_ext_usage`) |
| 20:02:06 → 20:18:21 | gap in `health.jsonl` (a 10 s sampler) | the laptop sleeps |
| 20:18:21 | `db.jsonl`: `[deadline] … no reply in 578ms (bound 60000ms) origin=conversations.usage:sync sql=insert into "conversations_ext_usage"` | on wake the 60 s timer fires at once — `setTimeout` ran through the sleep, `performance.now()` did not, so 578 ms of awake time had passed. The upsert HAD completed on the server |
| 20:18:21 → | pid 87346 `idle in transaction`, `ClientRead` | the client was **abandoned** (never closed, never sent `ROLLBACK`): Postgres keeps the transaction and its row locks for as long as the backend process lives |
| 20:30 → 00:55 | 15 sessions `INSERT … waiting` on `transactionid`, each blocked by the previous | every later usage sync queues on those rows; each waiter's own deadline fires after 60 s, so each is abandoned too |
| ~00:55 | 1 idle + 15 waiting = 16 = pgbouncer `default_pool_size` | every pgbouncer server slot for main's database is held by a dead session; every query — `SELECT 1` included — queues in pgbouncer forever |

Freeing it: `pg_terminate_backend(87346)` only passed the lock to the next dead
session (it finished its INSERT and sat idle in transaction); terminating all 16
restored main at once.

Nothing alerted usefully. Each deadline wrote one `db.jsonl` line and lit the
health dot's Database row for 10 minutes. (Correction, found by task 1: a
`db-query-deadline` report and a bell notification WERE filed at 20:18:21 for
the head — but the report said only "a query got no answer and was abandoned",
pointing at a stray-close hunt, and the chain behind it spread over dozens of
rows keyed by SQL text, one per `in (…)` arity.) Nothing tracked what the
abandoned connections went on holding, and `application_name` was empty, so
the blocker could not be attributed from the database side.

## Why connections are abandoned

`plugins/database/plugins/connection/server/internal/abandon.ts`, from the
2026-09-11 incident (`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`):
some code in the backend closed a file descriptor it did not own; the number had
been reused by a pooled pg socket, which died underneath a query that then waited
forever. The response was the deadline (every call fails after 60 s) plus the
abandon rule: on a missed deadline the connection is NOT closed, because its fd
number might already belong to an innocent resource that closing would kill.

The rule's written cost — "one leaked server connection" for a call that was
merely slow — is wrong twice:

1. **Inside a transaction the leak holds row locks**, indefinitely.
2. **The leak holds a pgbouncer server slot**, indefinitely. The app drops the
   abandoned client from its pool and opens a replacement; pgbouncer still counts
   the old one. Sixteen abandons on one database take it down, locks or not.

And the rule is itself a workaround: the code doing the stray close was never
found ("not found yet", 09-11). Abandoning made that symptom survivable and left
the cause in place.

## The vision

**A failure either cannot happen, or is recovered with nothing left behind — and
is reported. Nothing is set aside silently.** In order of cost:

1. **A stray close is inexpressible.** No raw fd numbers in app code: every
   descriptor lives in an owned handle that closes exactly once; a second close
   throws and names its caller. A lint bans closing a bare number and passing
   numeric fds as spawn stdio (the 09-10 victim was `spawnCaptured`'s temp-file
   fds). With fds owned, the reason to abandon is gone.
2. **A lost call cleans up.** Deadline fires → close the connection. Postgres
   rolls the transaction back and releases its locks; pgbouncer frees the slot.
   The "abandoned connection" concept disappears. Until (1) lands, the interim
   form: close when the fd is provably still ours (device + inode recorded at
   connect), abandon only when it is not — in which case the original socket was
   already closed and the server already rolled back.
3. **Deadlines measure awake time.** A sleep is not a silent connection.
   (Landed: `armAwakeDeadline`, `connection/server/internal/awake-timer.ts`.)
4. **Every deadline miss is a report**, deduped by origin, carrying the SQL and
   what else was in flight — not a log line and a dot that fades.
5. **No idle window inside a transaction.** A transaction that is a few writes is
   ONE statement (a data-modifying CTE, or a database function), so the server
   never waits on the app while holding locks. A multi-step body may issue only
   database calls.
6. **Background work cannot starve the UI.** The app's interactive/background
   lanes extend to pgbouncer: separate server pools per lane, so leaked or
   blocked background connections cannot take the slots `/home` needs.
7. **The database names who blocks whom.** Every query carries its origin as a
   SQL comment; a scheduled watchdog (a `defineJob` schedule — Postgres has no
   change signal for lock waits) reports blocking chains and long-idle
   transactions by origin, whatever caused them.
8. **Health is the current state.** The Database row says "blocked now" while it
   is, instead of clearing 10 minutes after the last event.

## Landed with this doc

- **(3) Awake-time deadline.** `DbClient`'s `connect()` and `query()` deadlines
  re-arm for what remains of their bound by `performance.now()` when the timer
  fires early (`awake-timer.ts`, tested in `awake-timer.test.ts`).
- **Interim backstop: `IDLE_IN_TRANSACTION_TIMEOUT_MS` (5 min).** The cluster's
  `idle_in_transaction_session_timeout` (`database/embedded`'s
  `applyClusterSettings`, run by the cluster start script — it first landed as a
  per-database `ALTER DATABASE` in every process's boot, and concurrent boots
  crashed with `tuple concurrently updated`), so Postgres ends a transaction an
  abandoned connection left open. This is a
  bound around our own design flaw, not a fix: it reaps each dead link of a chain
  after 5 min (a 16-link chain still costs ~80 min), and the reap is not reported.
  **Remove it when task 2 lands.**

## Proposed tasks

| # | Task | Vision | Notes |
|---|---|---|---|
| 1 | Deadline miss files a report (origin, SQL, in-flight trace), deduped by origin | 4 | connection plugin; `database/query-deadline` handles the sink |
| 2 | Find the stray fd close (09-11); owned fd handles + lint; then close lost connections instead of abandoning; remove the idle-in-transaction backstop | 1, 2 | connection plugin + `infra/spawn`; sequential after 1 (same files) |
| 3 | DB watchdog: origin-tagged queries, scheduled blocking-chain / idle-transaction report, Database health row shows current state | 7, 8 | independent |
| 4 | Separate pgbouncer pools per lane, app pool split to match, lane-capacity invariant end to end | 6 | independent; `database/pgbouncer`, `pg-driver.ts` |
| 5 | Usage sync writes in one statement; list other multi-round-trip background transactions | 5 | independent; `conversations/usage` |

Tasks 1–2 touch the same connection-plugin files and run one after the other;
3, 4 and 5 are independent of them and of each other. Every task: read
`plugins/database/CLAUDE.md` and `plugins/database/plugins/connection/CLAUDE.md`
first; done = checks pass and `./equin build` is green, pushed only on the user's
review.

### 1. A deadline miss files a report

Today `queryDeadlineSink` (`connection/server/internal/deadline.ts`) is drained by
`database/query-deadline`, which writes the `[deadline]` line to `db.jsonl` and
lights the health report's Database row for 10 minutes. (**Landed:** it already
filed a report per SQL label; it is now keyed by caller and carries the lost
connection's transaction state, every other call in flight, the abandoned
connections left in a transaction, and a linked trace — see
`plugins/database/plugins/query-deadline/CLAUDE.md`.) The connection plugin
cannot file a report itself (`reports` depends on `database`), so the report is
filed in `database/query-deadline`'s handler: a report kind (under
`plugins/reports`) deduped by `origin`, carrying pool, phase, SQL, elapsed vs
bound, and a trace of what was in flight (`plugins/debug/plugins/trace`). Also
report the `abandon-cap` event. Done = a forced deadline (the black-hole proxy in
`connection/server/testing`) files one report, and a second miss from the same
origin increments it.

### 2. Make the stray close impossible, then close instead of abandon

The 2026-09-11 culprit was never found; read
`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md` (victim
table, ranked suspects; the 09-10 victim was `spawnCaptured`'s temp-file fds,
`plugins/infra/plugins/spawn/core/internal/spawn-captured.ts`). Find it first. Then
make the class inexpressible: an owned descriptor handle that closes exactly once
and throws, naming its caller, on a second close, plus a lint that bans
`closeSync(<number>)` and numeric fds passed as spawn stdio outside that owner.
Then change `DbClient#lose` (`connection/server/internal/client.ts`) to CLOSE a
lost connection — Postgres rolls back, pgbouncer frees the slot — and delete the
abandon machinery (`abandon.ts`, `AbandonedClientHold`, the pg-pool internals
accessor) and the interim `IDLE_IN_TRANSACTION_TIMEOUT_MS` /
`CLUSTER_SESSION_SETTINGS` entry (`database/embedded/shared/internal/cluster-settings.ts`;
removing the entry leaves the value in `postgresql.auto.conf`, so `ALTER SYSTEM RESET`
it, and `ALTER DATABASE … RESET` the per-database copies the first version left on
the databases that booted it).
If the culprit cannot be found, the interim form is close-when-provably-ours:
record the socket's device + inode at connect, re-check at the deadline, close if
it matches, abandon only if not (then the original socket is already closed and
the server has already rolled back). First verify Bun exposes a pg socket's fd
reliably. Done = `deadline.test.ts` shows a lost client closed and its server
session gone from `pg_stat_activity`.

### 3. Database watchdog

- Tag every app query with its origin as a leading SQL comment
  (`/* origin=<currentEntryLabel()> */`) at the one place app queries pass
  through: `installQueryWrapper` in `database/machine/internal/pg-driver.ts`,
  including the checked-out-client path `db.transaction()` takes. Mind pgbouncer
  transaction mode (no session state, so not `application_name`) and the
  read-set capture, which parses SQL text (`extractReadTablesFromSql`).
- A `defineJob` on a schedule (Postgres has no change signal for lock waits; say
  so in the code) reads `pg_stat_activity` + `pg_blocking_pids` for its own
  database and files a report when a session has blocked others, or sat
  `idle in transaction`, past N minutes — naming the blocker's origin and SQL,
  how many wait and for how long.
- The health report's Database row (`database/query-deadline`) shows the current
  state ("blocked now: <origin> holds N sessions"), not only a fading window.
Done = a test or e2e that holds a row lock in a worktree DB sees the report and
the health row.

### 4. Separate pgbouncer pools per lane

pgbouncer (`database/pgbouncer/scripts/start.ts`: `pool_mode = transaction`,
`default_pool_size = 16`) has one pool per database for every app connection,
while the app splits interactive and background lanes (`backgroundQueryGate`,
`backgroundTxGate`, `RESERVED_INTERACTIVE` in `pg-driver.ts`; "Connection lanes"
in `plugins/database/CLAUDE.md`). Give each lane its own pgbouncer pool (distinct
database aliases or users with their own sizes), split the app pool to match,
keep the lane-capacity inequality asserted in `pg-driver.ts` true end to end, and
budget the cluster's `max_connections = 500` across every worktree. Design first
(`plan` skill). Done = a test showing interactive queries still answer while
every background slot is held.

### 5. Usage sync writes in one statement

`syncConversationUsage` (`conversations/usage/machine/internal/sync.ts`) ends in
a `db.transaction` with two round trips: the `conversation_usage_files` upsert,
then `conversationUsage.upsert(…, tx)` into `conversations_ext_usage`. Make it ONE
statement (a data-modifying CTE). Check what `conversationUsage.upsert`
(`infra/entity-extensions`) does beyond the insert — derived `updatedAt`
triggers, the change feed — so the CTE keeps every effect, and keep the
raw-SQL typing guardrails (`database/sql-rows`, `database/sql-projection`). List
other multi-round-trip background transactions that could be single statements;
don't change them. Done = `./equin test plugins/conversations/plugins/usage`
passes and a real conversation's totals are unchanged.

**Landed (2026-11-04).** `writeUsage` (`usage/machine/internal/write.ts`) issues
`WITH files AS (<files upsert>) <totals upsert>`, one statement. To build it,
`entity-extensions` gained `upsertQuery(id, values): SQL`, which is `upsert`'s
statement built but not run. `upsert` itself is a plain
`INSERT … ON CONFLICT DO UPDATE … RETURNING`, and its effects (the derived
`updatedAt` row trigger, the change feed's statement triggers) all happen in the
database, so the CTE keeps all of them. A real-Postgres test
(`write.test.ts`) covers each branch and the trigger.

Trap: drizzle wraps an embedded query *builder* in parentheses, so
``sql`WITH a AS (${builder}) …` `` renders `((insert …))`, which is a syntax
error. Embed `.getSQL()` (a plain `SQL`) instead.

**Other multi-round-trip background transactions** (listed, not changed),
ranked by fit:

- Pure writes, so one statement fits:
  - `tasks/task-title/machine/internal/short-title-job.ts:57`: `FOR UPDATE`, a
    string compare, then an upsert. Can be one `INSERT … SELECT … WHERE title = $`.
  - `infra/jobs/machine/internal/dead-job-gc.ts:39`: archive `INSERT … SELECT`,
    then `DELETE`s.
  - `apps/events/refresh/server/internal/run-ledger.ts:96`: run, run-events,
    source-state.
  - `apps/chord/song-index/server/internal/load.ts:82`: chunked inserts.
  - `infra/events/server/internal/trigger-contributions.ts:47`: one delete and
    one insert per trigger table.
  - `apps/events/events-core/server/internal/events-repo.ts:250`: per-row
    updates whose plan is computed beforehand. Fits
    `UPDATE … FROM (VALUES …)`.
- Maybe:
  - `infra/claude-cli/server/internal/record-call.ts:28`: insert,
    ring-trim, horizon.
  - `events-repo.ts:73`: N upserts.
  - `places-core/server/internal/seed.ts:71`: `LOCK`, count, insert.
  - `deploy/analytics/collect/server/internal/aggregate-sql.ts:264`: delete
    and insert per table. Two statements; one would hit same-key conflicts.
- No (a lock or app logic sits between statements, so this needs redesign, not
  a CTE): `op-store/store.ts:240`; the `watch.*` jobs; the queue rank jobs
  (`lockDeck`); `inline-date/reconcile.ts:44`; `editor-collab/doc-store.ts:86`
  (Yjs merge); the boot DDL installers.

**Next rung (not done).** The existing lint `database/no-pool-await-in-transaction`
keeps awaits inside a transaction on `tx`. It still allows a transaction of
several `tx` round trips with app work between them. That is exactly the
idle-in-transaction window this task closed. Two ways to turn it into an
enforced rule:

- A lint that flags a `db.transaction` callback awaiting two or more
  statements and none of `FOR UPDATE`, an advisory lock or a read whose result
  feeds a later write (the cases that genuinely need a transaction). It would
  point to a CTE. Its exemptions would be the "No" list above.
- Removing the need structurally: an atomic multi-write primitive
  (`writeAtomically(exec, [w1, w2, …])`, composing CTE arms the way
  `writeUsage` does by hand) so a background writer never needs
  `db.transaction` for pure writes.

## Runbook: a database wedged by an abandoned transaction

Symptom: pages hang on "Waiting for the server…", `db.jsonl` shows `[deadline]`
lines even for trivial SQL. Look (read-only) at `pg_stat_activity` for the
database: `state`, `wait_event_type`, `xact_start`, `pg_blocking_pids(pid)`. An
`idle in transaction` session at the head of a `Lock` chain is the blocker.
**Ending only the head does not free it**: every waiter's own deadline has
expired, so its client abandoned it too — the next waiter takes the lock,
finishes its statement and sits idle in transaction in turn. End the whole chain
(every session of it older than the 60 s deadline), or restart the backend that
holds the sockets. The interim 5-min timeout (above) reaps such a chain one link
at a time until task 2 lands.
