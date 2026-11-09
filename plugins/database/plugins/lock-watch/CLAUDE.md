# lock-watch

Names who blocks whom on this worktree's database. Once a minute a job reads
`pg_stat_activity` + `pg_blocking_pids` and names every session that has held
other sessions back, or sat `idle in transaction`, for longer than
`LOCK_WATCH_THRESHOLD_MS` (60 s — the query deadline's default, so a waiter
past it has already been failed by its own deadline). It names each one by the
**origin** its statement carries: the app pool puts
`/* origin=<entry label> */ ` in front of every statement
(`database#machine`'s `tagClientQueriesWithOrigin`; the format is
`database/connection` core's `tagSqlWithOrigin` / `parseSqlOrigin`).

Why: on 2026-11-03 a chain of 16 sessions blocked main for 5 h. The head was a
`conversations.usage:sync` transaction whose connection had been abandoned
mid-transaction; `application_name` was empty, nothing reported the chain, and
the health dot's Database row faded 10 minutes after the last deadline event.
Vision and incident: [`research/2026-11-04-global-db-connection-failure-vision.md`](../../../../research/2026-11-04-global-db-connection-failure-vision.md)
(points 7 and 8).

## It only reports

The watch never ends a session. Its job is to point at the code that left a
transaction open so that code gets fixed; terminating the session would make
the symptom disappear and keep the cause. Freeing a wedged database by hand is
the runbook in `plugins/database/CLAUDE.md`.

The CLUSTER does end one: `idle_in_transaction_session_timeout` (5 min,
`database/embedded`) is the bound around app code that stalls between two
statements of a transaction. So a session the watch names idle for minutes is
reaped at 5 — and every reap is reported, below.

## Sessions the idle-in-transaction timeout ends

The `db-idle-transaction-ended` report: `variant: "error"`, `duressExempt`,
one row per origin (untagged: per pool, or per `application_name`), every end
bumping it. The payload names the transaction's LAST statement and its origin
(the code that went quiet with the transaction open), its age and idle time.
Every reap files one, from whichever observer can see it — each misses what
the other sees (`core/internal/idle-ended.ts`):

| observer | sees | cannot see |
|---|---|---|
| **the session's own client** (`database/connection`'s `DbClient`: Postgres's `FATAL 25P03`, reached as an `error` event, directly and through PgBouncer) → `idleTransactionEndedSink` → `server/internal/idle-ended-handler.ts`, source `server-caught` | exact, at once: origin of the last and first statements, the statement, the pool | a session it did not open (psql, a raw client); a process whose event loop never runs again |
| **the watch** (`idle-ended-watch.ts`): a session it saw idle in a transaction on one look is gone on the next (no session with that pid AND backend start), had been idle long enough by then to reach the bound it reads from `pg_settings`, and `pg_stat_database.sessions_fatal` rose in between (a reap is a FATAL end; a closed client counts as abandoned, `pg_terminate_backend` as killed) — longest idle first, no more than the FATAL count; source `server-db-lock-watch` | any session on its database, app or not — the last statement and origin as `pg_stat_activity` showed them | an inference, a minute coarse; another FATAL end in the same minute could be counted; blind while the watch does not run (a backend's first look compares with nothing) |
| Postgres's own log (`postgres.log`: `FATAL: terminating connection due to idle-in-transaction timeout`) | every reap on the cluster | only the pid and time (`log_line_prefix` `%m [%p]`) — read it next to the `[lock-watch]` lines, which carry the pid; nothing reads it |

One reap, one report: a session whose `application_name` is a reporting app
client's (`equin:<pool>`, `isDbApplicationName` — a backend, serving or exec;
a CLI process logs in as `equin-cli:<pool>` and is reported by the watch) is
that client's to report, so the watch only logs it (`[lock-watch] … reported
by its client`) — every reap the watch concludes is in `db.jsonl` either way.
The handler is a `sinkHandlers` entry, attached by the framework in every
boot mode, so an exec child (a supervised job's body) reports its ends too. Left to the client and so unreported: a backend whose event loop
never runs again — its session was named by `db-lock-holder` every minute
before the end. Lost to the watch: an end between a backend's last look and
its successor's first (`previous` lives in memory), and an unrelated FATAL in
the same minute can be attributed to a session that committed — it is an
inference.

## How a look works (`server/internal/watch-job.ts`)

- **A schedule, not a push.** Postgres has no change signal for a lock wait or
  for a session going idle in a transaction — no NOTIFY, trigger or hook — so
  `defineJob({ schedule: { cron: "* * * * *", perWorktree: true } })`.
- **Its own direct session, held between looks** (`held-session.ts`: the
  `lock-watch` pool, `database/admin`'s `openHeldClient`; never pgbouncer), so a
  wedge that has taken every pgbouncer slot is still seen — and so is a stall
  of NEW connections, which a fresh connection per look queued behind. On
  2026-11-04 every new direct connection on the cluster went unanswered for a
  minute; the watch, then opening one per look, saw nothing. A lost session
  leaves the pool and the next look opens another; `onShutdown` closes it.
- **The head of each chain, not every waiter** (`lockHolders`, core, pure):
  a session that blocks others and waits on nobody. Waiters are counted
  transitively, so the head of a 16-link chain "holds 15". A blocker outside
  the read (another database, autovacuum) is not described; a wait cycle names
  nobody (Postgres's deadlock detector ends it).
- **Then, in order:** the in-memory latest look (`publishObservation` → the
  `db-lock-watch` push value), a `[lock-watch]` line per holder in `db.jsonl`,
  and only then a `db-lock-holder` report per holder, unawaited — the report is
  written through `db`, the very pool a wedge starves, and a stuck write must
  not hold the singleton job past the next look.
- **Last, a probe of a new connection** (`connect-probe.ts`): one fresh
  `admin-short-lived` connect + `SELECT 1`, the connection the watch used to
  read on. Still unanswered after `CONNECT_STALL_MS` (5 s), the held session
  reads what the whole cluster is doing — every database, every backend type:
  backend count against `max_connections`, and the oldest busy backends with
  their wait events and statements (`cluster-activity.ts`) — into `db.jsonl`
  as `[lock-watch]` lines (`stalledConnectLines`), while the stall is still on.
  It files no report: the probe's own missed deadline does (`db-query-deadline`
  on `admin-short-lived`), and it fails the job as before. Read the lines next
  to Postgres's own `connection received` / `connection ready` lines
  (`log_connections`, `database/embedded`'s cluster settings): a probe with no
  `received` line was never accepted by the postmaster.
  A half-open connection does not show in `pg_stat_activity` (measured on PG
  18.3), so the snapshot shows what else the cluster was doing, not the stuck
  connect itself.

## The `db-lock-holder` report

`variant: "error"`, `duressExempt`, source `server-db-lock-watch`. One row per
**origin** per worktree (an untagged session — another pool, a psql shell — is
keyed by its `application_name` instead — a statement or pid would mint a row per look); every look that still sees it bumps the row,
so `count` is the number of minutes it was seen. The payload is the holder as
the look saw it (pid, origin, statement without the comment, state,
`application_name`, transaction age, idle time, waiting count, longest wait)
plus the bound in force.

## The `db-lock-watch` value and the Database row

`dbLockWatch` (`core`) is a `liveValue` served external (`state.ts`): the latest
look, `null` until the watch has looked once since the backend started. That
first look is not left to the cron's next minute: a `worktree` warm-up
(`first-look-warmup.ts`) enqueues the job once the backend has settled — the
singleton's manual enqueue shares the cron's pending row and makes it due now.
The
health report's Database row (`database/query-deadline`) reads it next to the
deadline ring and shows the state NOW:

- a session holding others back → `critical`, "Blocked now: <origin> holds 15
  sessions (longest wait 4 min), idle in its transaction for 5 min — as of 10:21";
- one idle in its transaction → `attention`, "Now: <origin> has sat idle in its
  transaction for 3 min — as of 10:21";
- not looked yet (a backend's first minute) → `unknown`, never green;
- the latest look older than three ticks (`LOCK_WATCH_STALE_MS`) → `attention`,
  "The lock watch has not looked since 10:21": the watch itself stopped. One
  timer to that instant, re-armed by every look's push — no polling;
- otherwise the deadline verdict, its `ok` summary saying when the watch last
  looked. The row is the worse of the two parts; a failed read of one never
  hides the other.

The words are `describeLockHolder` (core), shared by the report and the row.

## Tests

- `core/internal/observation.test.ts` — the chain analysis, pure.
- `server/internal/watch.test.ts` — a real row lock on a throwaway database:
  an origin-tagged `UPDATE` left idle in its transaction, a second `UPDATE`
  queued on it, the watch's read naming the holder and the report it files;
  and the cluster look naming a sleeping backend with its wait event.
- `core/internal/idle-ended.test.ts` — which ended sessions the watch
  attributes to the timeout, pure (FATAL count, pid reuse, bound not reached).
- `server/internal/idle-ended.test.ts` — the timeout end to end, on a throwaway
  database whose own bound is 1 s: a transaction left idle is ended, its client
  files the report with its origin and statement, its write is rolled back,
  its next call fails with `IdleTransactionEndedError`, and the watch's two
  looks conclude the same session ended (and leave the report to its client).
- `server/internal/connect-probe.test.ts` — the probe, pure: no look when the
  connect answers in time, a look while it is still pending when it does not,
  and every failure still loud.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Database lock watch: a per-worktree job that looks at pg_stat_activity + pg_blocking_pids once a minute (Postgres has no change signal for lock waits), on a held direct session that neither a saturated pgbouncer nor a stall of new connections can starve, and names every session holding others back or idle inside a transaction past 60 s by the origin its statement's comment carries — a db-lock-holder report (one row per origin) and the db-lock-watch push value behind the health report's Database row. Each look also probes a new connection; one still unanswered after 5 s gets a snapshot of every busy backend on the cluster, read on the held session, in db.jsonl. Its first look is enqueued at boot by a warm-up, so a restarted backend does not wait for the next minute. It never ends a session. Every session the cluster's idle-in-transaction timeout ends is reported (db-idle-transaction-ended, one row per origin): from the session's own client (database/connection's idleTransactionEndedSink, SQLSTATE 25P03) or, for a session no app client owns, from the watch seeing it gone between two looks with pg_stat_database.sessions_fatal up.
- Server:
  - Contributes:
    - `report-kind` "db-idle-transaction-ended"
    - `report-kind` "db-lock-holder"
    - `resource.declare` "db-lock-watch"
  - Uses:
    - `database.dbLog`
    - `database/admin.openHeldClient`
    - `database/admin.openShortLivedClient`
    - `database/connection.formatIdleTransactionEndedLogLine`
    - `database/connection.IdleTransactionEndedEvent`
    - `database/connection.idleTransactionEndedSink`
    - `infra/jobs.defineJob`
    - `infra/warmup.defineWarmup`
    - `network/live.serveValue`
    - `reports.ReportKind`
    - `reports.ReportRow`
    - `reports/engine.recordReport`
  - Register:
    - `defineJob('database.lock-watch')`
    - `defineWarmup('database.lock-watch.first-look')`
  - Resources: `db-lock-watch` (push, notified)
- Core:
  - Uses:
    - `database/connection.parseSqlOrigin`
    - `network/live.liveValue`
  - Exports (types):
    - `DbIdleTransactionEndedPayload`
    - `DbLockHolderPayload`
    - `IdleSessionSeen`
    - `LockHolder`
    - `LockWatchObservation`
    - `LockWatchState`
    - `SessionRow`
  - Exports (values):
    - `cutLockWatchSql`
    - `DB_IDLE_TRANSACTION_ENDED_KIND`
    - `DB_LOCK_HOLDER_KIND`
    - `DbIdleTransactionEndedPayloadSchema`
    - `DbLockHolderPayloadSchema`
    - `dbLockWatch`
    - `describeLockHolder`
    - `holderName`
    - `idleEndedPayloadFromWatch`
    - `idleSessionsEnded`
    - `idleSessionsSeen`
    - `LOCK_WATCH_HOLDERS_MAX`
    - `LOCK_WATCH_SQL_MAX`
    - `LOCK_WATCH_THRESHOLD_MS`
    - `lockHolders`
    - `LockHolderSchema`
    - `LockWatchObservationSchema`
    - `LockWatchStateSchema`
- Cross-plugin:
  - Imported by: `database/query-deadline`

<!-- AUTOGENERATED:END -->
