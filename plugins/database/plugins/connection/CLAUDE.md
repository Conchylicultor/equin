# connection

The one way a backend process opens a database connection. Every pool and every
standalone client is built here, and every one of them gives up on a call that
gets no reply: opening the connection, or a statement on it.

```ts
import {
  createDbPool,
  createDbClient,
  withQueryDeadline,
} from "@plugins/database/plugins/connection/server";

const pool = createDbPool({ name: "job-lock", connectionString, max: 4 });
const client = createDbClient({ name: "events-test", connectionString });
```

`openListenSession({ name, connectionString, channels, handlers, endFailed })`
is a LISTEN session on its own `createDbClient` connection: connect, then
`LISTEN a; LISTEN b` as ONE statement (both channels start together), each
under the deadline; a failed attempt is closed and the open rejects. Once
established, a connection `error` or `end` reaches `handlers.lost` once — and
only while the session is current, so a failed attempt's late socket events
never reach the caller. It is the desktop's `DatabaseDriver.listen`
(`database#machine`), which the change feed's listener opens; the reconnect
policy stays in the listener.

Plan: [`research/2026-09-16-global-db-call-deadline-every-connection.md`](../../../../research/2026-09-16-global-db-call-deadline-every-connection.md).
Background: [`research/2026-09-11-global-query-deadline-and-stall-health.md`](../../../../research/2026-09-11-global-query-deadline-and-stall-health.md)
and the incident it answers,
[`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`](../../../../research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md).

## Why the clock is on the connection

On 2026-09-15 a job waited 2.5 hours on a database call that never answered.
Only the app pool behind `db` had a deadline then, and it started only once a
connection was handed out — so opening a connection had no bound anywhere, and
the job queue's own pools had none at all.

Every path to the database ends in two methods of a `pg.Client`: `connect()` and
`query()`. That holds for the app pool's wrapper, drizzle, graphile-worker (which
checks clients out itself, and connects its LISTEN client with a callback),
pg-pool's own `pool.query`, and a bare client. So the deadline is **one
`pg.Client` subclass** (`DbClient`, `server/internal/client.ts`), and
`createDbPool` / `createDbClient` build every connection with it.

- **`query()`** — bounded in promise form and in the positional callback form
  (pg-pool's `pool.query` uses that one). A Submittable (pg-cursor,
  pg-query-stream) and a config object carrying its own `callback` pass straight
  through.
- **`connect()`** — bounded in both forms. pg-pool calls `client.connect(cb)`.
- **The clock** starts at the call. Its bound is `QUERY_DEADLINE_MS` (60 s —
  equal to Postgres's own `authentication_timeout`), or the enclosing
  `withQueryDeadline({ ms, reason }, fn)` scope's. The scope is an
  `AsyncLocalStorage`, read synchronously at the call along with the caller
  (`currentEntryLabel()`).
- **Not pg's `connectionTimeoutMillis`.** It bounds only the connect, counts
  a sleep as elapsed, and reports nothing.
- **The clock counts awake time only** (`armAwakeDeadline`,
  `server/internal/awake-timer.ts`). See "A sleep is not a silent connection".
- **Queue wait is not bounded.** Waiting for a free connection is back-pressure,
  and every held connection has its own bound that frees it.

## What happens when a call gets no reply

The caller gets a `QueryDeadlineExceededError`: `pool`, `phase`
(`connect` | `query`), `sql` (the query's profiler label, or `[connect]`),
`elapsedMs`, `deadlineMs`, `origin` (the runtime-profiler entry, `null` when
context-less) and `reason` (the scope's, `null` under the default). It has no
`.code`, so the app pool's deadlock retry never re-runs a lost statement.

The client is then **lost**, for good:

1. **Closed.** A checked-out client is handed back to its pool as broken with
   pg-pool's own `release(err)` for that checkout — pg-pool's public way to
   drop a client: it leaves the pool, pg-pool `end()`s it, and the queue is
   pulsed so a waiting checkout gets a replacement. A standalone client, or
   one whose connect timed out (pg-pool's connect callback already dropped
   it), is `end()`ed directly. Either way `end()` on a lost client destroys its
   socket outright: pg's own `end()` closes gracefully when no statement is
   active (Terminate, then wait for the server), and a lost connection may
   never answer. The server sees the session end: Postgres rolls back any
   transaction it was in and releases its locks, and PgBouncer frees its
   server slot. A session still mid-statement (running, or waiting on a lock)
   is cancelled by the cluster's `client_connection_check_interval`
   (`database/embedded`) instead of running to completion. No pg-pool
   internals are touched.
2. **Recorded**: a `<sql>[deadline]` `db` span and an event on
   `queryDeadlineSink`. This plugin cannot file a report (`reports` depends on
   `database`), and does not write `db.jsonl` either (see "Why it is its own
   plugin"): `database/query-deadline`'s handler does both, writing the
   `[deadline] pool=… phase=…` line (`formatDeadlineLogLine`) to `database`'s
   `dbLog`.
3. **Every other call on it fails at once** with the same error — calls already
   queued behind the lost one included, since pg runs one statement per
   connection. drizzle's `ROLLBACK` after a lost statement therefore costs
   nothing.
4. **The holder's own `release()` does nothing more.** The deadline already
   handed the client back; a second release would be pg-pool's double-release
   throw. pg-pool assigns `release` on every checkout, right after emitting
   `acquire`, so `DbClient` takes it through an accessor: `createDbPool`'s
   `acquire` listener marks the next assignment as pg-pool's own, and any other
   (the app pool's background lease wraps it, `armLease`) as a holder's.
5. **`onClientLost(client, fn)` subscribers are told**, synchronously. A lease
   owner uses it to end bookkeeping tied to the connection: the app pool frees
   its background-transaction gate slot there.

A late real reply (a slow call, not a lost one) never arrives: its socket is
gone, and its call was already settled.

### Why close (it used to be abandoned)

Until 2026-11-04 a lost connection was **abandoned** — detached from its pool,
held, never closed — because of the 2026-09-11 incident: something in the
process had closed a file descriptor it did not own, the number had been reused
by a pooled pg socket, and closing a lost client might close whatever innocent
resource held its fd number by then. The culprit was found on 2026-09-16: Bun
≤ 1.3.14 closed a finished child's extra stdio fds a second time at garbage
collection (oven-sh/bun#33828, fixed in 1.4.0), and Playwright hands Chromium
two such fds on every launch. Bun is pinned past it, and the `bun-runtime` check
reproduces the defect against the running Bun on every build and push.

Abandoning was itself costly: an abandoned connection inside a transaction kept
its row locks, and every abandoned connection kept a PgBouncer server slot,
both for as long as the process lived. On 2026-11-03, 16 of them took main down
for five hours (`research/2026-11-04-global-db-connection-failure-vision.md`).
Closing is what makes a lost call clean up after itself.

Closing does rely on no one else having closed the lost socket's number. The
app's own code cannot: every descriptor it opens is an `OwnedFd`
(`packages/owned-fd`), closed exactly once, and a second close throws at the
culprit (`owned-fd/no-raw-fd-close`, `owned-fd/no-raw-spawn-stdio-fd`). Bun's
own double closes are re-proved absent by the `bun-runtime` check.

## A sleep is not a silent connection

A timer keeps running while the machine sleeps; `performance.now()` pauses with
it. So on wake every deadline whose time passed during the nap fires at once —
before the reply had any awake time to arrive. The deadline therefore re-arms
for what remains of its bound by `performance.now()`: the bound is awake time.

The incident (2026-11-03, main): a `conversations.usage:sync` transaction
upserted `conversations_ext_usage` at 20:02 and the laptop slept until 20:18;
on wake the 60 s deadline fired with 578 ms of awake time elapsed and abandoned
the connection mid-transaction (the rule then). Postgres showed it `idle in
transaction` for 5 h; every later usage sync queued on its row locks, each
holding an app-pool connection, until the pool was gone and `/home` sat on
"Waiting for the server…". Both halves are fixed: the clock counts awake time,
and a lost connection is closed, so its transaction is rolled back at once.

## When the server ends an idle transaction

The deadline bounds a call in flight. Nothing on the client bounds the time
BETWEEN two statements of a transaction: app code that is alive but stalled
(awaiting something other than the database, or wedged) with the transaction
open keeps its row locks and its lane slot. The cluster's
`idle_in_transaction_session_timeout` (5 min, `database/embedded`) is that
bound — a bound around app code that stalls, not a fix: Postgres ends the
session and rolls the transaction back.

The client sees it at once: Postgres sends `FATAL 25P03` the moment it ends
the session, and pg delivers it as an `error` event — directly, and through
PgBouncer, which forwards it before its own `server conn crashed?` (both
measured, PG 18 / PgBouncer, 2026-11-04). The NEXT call does not carry the
code; pg only says "not queryable". So `DbClient`:

- **remembers, per connection, the transaction it is in** as of each reply
  (ReadyForQuery `T`/`E`): its first statement's origin and its latest
  statement's origin and label — two field writes per statement;
- **catches the 25P03 in `emit`**, not in a listener, so whether the holder
  listens (and whether an unheard `error` kills the process) is unchanged —
  and on a call's error reply too: code wedged past the bound sends its next
  statement before reading the FATAL already in its socket, and pg settles
  that call (and every queued one, before it emits `error`) with it;
- **announces it on `idleTransactionEndedSink`**: pool, `origin` and `sql` of
  the last statement before the stall, `openedBy`, transaction age and idle
  time (awake clock). `database/lock-watch` logs it to `db.jsonl` (`[idle-tx]`
  line, `formatIdleTransactionEndedLogLine`) and files a
  `db-idle-transaction-ended` report; in a CLI process the line goes to stderr;
- **fails every later call with `IdleTransactionEndedError`** (no `.code`,
  never retried), naming the stalled origin and that the work was rolled back;
- the pool's connection-error listener files nothing for it, nor for the
  errors that follow on the same connection: the sink names the code.

It cannot see a session it did not open (a psql shell, a raw client) or one
whose process never runs its event loop again; the lock watch covers those
(`database/lock-watch`, "Sessions the idle-in-transaction timeout ends").

**Every connection logs in as `application_name` `equin:<pool>`**
(`dbApplicationName`, core) — `equin-cli:<pool>` from a process with no
runtime namespace (a CLI run), which drains no sink and only writes stderr,
so the watch reports those itself. A client's STARTUP `application_name` survives
PgBouncer's transaction pooling (PgBouncer re-applies it to whichever server
session the client is linked to; a `SET` would not), so `pg_stat_activity`
tells the app's sessions from anyone else's — which the lock watch uses to
leave a session's end to the client that owns it (`isDbApplicationName`). It
names the connection, never the caller: that stays the origin comment.

## When a connection breaks

A connection that *breaks* is a different event from one that goes silent: its
socket errors (the server terminated the session, the cluster restarted). With no
listener, that `'error'` event kills the process. pg-pool re-emits an idle
client's error on the pool, and a checked-out client emits it on itself. So
`createDbPool` attaches both listeners itself: one on the pool, and one on each
client as it connects. No consumer adds its own.

Neither listener recovers anything, because nothing needs it: pg-pool has already
dropped the idle client, and a checked-out client is no longer queryable. Its
holder's next statement rejects, and pg-pool drops it on release. The listeners
report the error, once per connection, as
`[db] pool=<name>: connection error: …` — except the server's idle-in-transaction
end and what follows it, which `idleTransactionEndedSink` reports. In a backend that goes to
`reportServerError` (`errorType` `DbConnectionError`); in a CLI process it goes to
stderr. A lost client is never reported: the deadline closed it, and already
reported that.

This also covers libraries handed a pool. graphile-worker (`infra/jobs`, given
`jobs-runner` / `jobs-enqueue` as `pgPool`) installs its own logging handlers,
with a "Your pool doesn't have error handlers!" warning, only on a pool that has
none.

## A statement names its caller

`tagSqlWithOrigin(text, label)` / `parseSqlOrigin(text)` (`core`) are the one
spelling of the origin comment the app pool puts in front of every statement
(`/* origin=<label> */ `; applied by `database#machine`, read back by
`database/lock-watch` from `pg_stat_activity`). `queryText` strips it, so a
span label and a `QueryDeadlineExceededError.sql` are the statement alone —
the caller already has its own field, `origin`.

## Pool names

A closed list in `core` (`DB_POOL_NAMES`, `DbPoolName`) — plain data both
runtimes read, not a slot:

| name | connection | built in |
| --- | --- | --- |
| `app` | the app's interactive-lane pool behind `db` (through pgbouncer); also boot and other context-less work | `database#machine` `pg-driver.ts` |
| `app-background` | the app's background-lane pool (through pgbouncer, as the background role, its own server pool) | `database#machine` `pg-driver.ts` |
| `jobs-runner` | graphile-worker's job-running pool, shared by the three runners | `infra/jobs` `worker.ts` |
| `jobs-enqueue` | graphile-worker's `WorkerUtils` pool (`addJob`), handed over as `pgPool` | `infra/jobs` `worker.ts` |
| `jobs-schema` | the boot-time job-queue schema installer (boot-DDL bound) | `infra/jobs` `queue-schema.ts` |
| `job-lock` | the advisory-lock pool behind `withJobLock` | `infra/jobs` `job-lock.ts` |
| `admin` | the admin pool (fork, drop, list) | `database/admin` `pool.ts` `getAdminPool` |
| `admin-short-lived` | one-off pools opened and closed around a single operation | `database/admin` `pool.ts` `openShortLivedClient` |
| `lock-watch` | the lock watch's held session on its worktree's database, kept open between looks so a look still runs while new connections stall | `database/admin` `pool.ts` `openHeldClient`, held by `database/lock-watch` |
| `fork-lease` | the session holding a DB fork's temp lease (an advisory lock), from before its temp exists to after the rename; the temp sweep tries it before a drop | `database/admin` `fork-lease.ts` |
| `change-feed` | the change-feed LISTEN client | this plugin's `listen-session.ts` (`openListenSession`), opened by `database#machine`'s `DatabaseDriver.listen` for `network/live/change-feed`'s `listener.ts` |
| `events-test` | the events-test harness's stand-in worker sessions | `infra/events-test` `crash-recovery.ts`, `superseded.ts`, `queue-lock-no-steal.ts` |

Whole-database DDL on `admin` (`CREATE` / `DROP` / `RENAME DATABASE`) runs under
a 10 min bound through `database/admin`'s `runDatabaseDdl`.

**A queued checkout keeps its caller's context.** When the pool is full,
pg-pool hands a queued checkout its connection from inside another caller's
`release()`, so its callback — and a `pool.query` statement issued from it —
would run in the releaser's async context: wrong `withQueryDeadline` bound,
wrong `origin`. `createDbPool` binds every callback-form `pool.connect(cb)`
(which `pool.query` goes through) to the context of the call
(`AsyncLocalStorage.bind`). The promise form needs nothing: an `await`
continuation runs in the awaiter's context. Both are pinned by
`deadline.test.ts`.

**In a CLI process** (`./equin build`, `db fork`, `deploy` open admin
connections) there is no runtime namespace, so no per-worktree `db.jsonl`: the
`[deadline]` line goes to the process's stderr instead, written by this plugin
when `hasRuntimeNamespace()` is false — nothing drains `queryDeadlineSink`
there. The caller gets its error before anything is reported, and no report is
filed.

## Test support

`startBlackHoleProxy(upstream)` (`server/testing/black-hole-proxy.ts`, published as `@plugins/database/plugins/connection/server/testing`) puts a
TCP proxy in front of the cluster whose forwarding can be switched off, so a
suite can make any connection's calls go unanswered. `deadline.test.ts` uses it
for the client itself; `infra/jobs`'s `enqueue-deadline.test.ts` uses it to prove
the enqueue pool's wiring.

## Why it is its own plugin

`database/server` (the app pool), `database/admin`, `network/live/change-feed` and
`infra/jobs` all build connections, and `jobs` sits below plenty of things that
import `database`. So this plugin imports nothing of theirs: only `pg`,
`primitives/report-sink`, `infra/runtime-profiler/core`,
`infra/runtime-identity/core` and `framework/product-name/core` (the
`application_name` prefix).

**Never import `primitives/log-channels/server` here.** That barrel carries HTTP
and WS routes, which reach `endpoints` and its DOM-typed codec. Admin connections
are opened from CLI and tools code (`paths/scripts/migrate-data-layout.ts` →
launcher → `database/admin`), and the `tools` type-check target has no DOM lib,
so the import broke it. The `db` channel lives in `database/server`.

## A connect refused because the database is full

`isConnectionCapacityRefusal(err)` (`core`) recognises exactly two refusals:
pgbouncer's `FATAL 08P01 no more connections allowed (…)` (its host-wide
`max_client_conn`; matched on SQLSTATE AND pgbouncer's fixed text, since 08P01
alone is any protocol violation) and Postgres's `53300 too_many_connections`.
It walks `cause` and `AggregateError.errors`. Both are back-pressure — the same
connect succeeds once holders let go — so `database`'s `isTransientDbError`
counts them, and a supervised child that fails on one exits EX_TEMPFAIL
(`infra/jobs/supervised-job`) so its waiter retries later instead of counting
a failure.

## Not covered

A LISTEN connection with no call pending has nothing waiting for a reply, so no
deadline sees it go silent. That needs a heartbeat.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Every backend database connection, built one way: createDbPool / createDbClient give each pool or standalone client a name from the closed pool-name set and a pg.Client subclass that bounds connect() and every query() with a deadline (60 s, widened per scope by withQueryDeadline). A call with no reply rejects with QueryDeadlineExceededError (pool, phase, sql, origin), and its connection is closed — handed back to its pool as broken and its socket destroyed, so Postgres rolls back its transaction and PgBouncer frees its slot — and announced on queryDeadlineSink. A session the server ends for idling inside its transaction (25P03) is announced on idleTransactionEndedSink with the origin and statement of the transaction's last statement, and every later call on that connection fails with IdleTransactionEndedError. Every connection logs in as application_name equin:<pool> (equin-cli:<pool> from a process with no runtime namespace, which reports nothing). Every pool also carries its own connection-error listeners (pool and per client), which report a broken connection once instead of letting it crash the process — so a library handed the pool (graphile-worker) installs none of its own.
- Core:
  - Uses: `framework/product-name.PRODUCT_NAME`
  - Exports (types):
    - `DbCallPhase`
    - `DbPoolName`
    - `DbTxState`
    - `SqlOrigin`
  - Exports (values):
    - `DB_CALL_PHASES`
    - `DB_POOL_NAMES`
    - `DB_POOLS_THROUGH_PGBOUNCER`
    - `DB_TX_STATES`
    - `dbApplicationName`
    - `IN_FLIGHT_REPORT_MAX`
    - `isConnectionCapacityRefusal`
    - `isDbApplicationName`
    - `isInTransaction`
    - `ORIGIN_LABEL_MAX`
    - `originCommentLabel`
    - `parseSqlOrigin`
    - `tagSqlWithOrigin`
- Cross-plugin:
  - Imported by:
    - `database`
    - `database/admin`
    - `database/lock-watch`
    - `database/query-deadline`
    - `infra/events-test`
    - `infra/jobs`
    - `infra/jobs/supervised-job`
    - `infra/paths/root-migration`
- Server:
  - DB schema: `plugins/database/plugins/connection/server/internal/schema-generation.ts`
  - Exports (types):
    - `CreateDbClientOptions`
    - `CreateDbPoolOptions`
    - `IdleTransactionEndedEvent`
    - `ListenSessionHandlers`
    - `OpenListenSessionOptions`
    - `QueryDeadlineEvent`
    - `SchemaGenerationLocks`
    - `SchemaGenerationLocksOptions`
  - Exports (values):
    - `BOOT_DDL_QUERY_DEADLINE_MS`
    - `createDbClient`
    - `createDbPool`
    - `createSchemaGenerationLocks`
    - `currentQueryDeadline`
    - `formatDeadlineLogLine`
    - `formatIdleTransactionEndedLogLine`
    - `idleTransactionEndedSink`
    - `onClientLost`
    - `openListenSession`
    - `QUERY_DEADLINE_MS`
    - `queryDeadlineSink`
    - `queryText`
    - `withQueryDeadline`
- Exemptions:
  - Exempts itself from:
    - `db-connection/no-raw-pg-connection` — `.` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/client.ts`, `server/internal/deadline.ts` (debt)
  - Exempted by: `database/connection` (0 debt)
- Test helpers:
  - Server: `@plugins/database/plugins/connection/server/testing`
    - `IdleTransactionEndedError` — What a call on a connection whose session the server ended for idling in its transaction gets — the stalled transaction's own next statement, typically: its work was rolled back.
    - `QueryDeadlineExceededError` — A database call got no reply within its deadline.
    - `startBlackHoleProxy` — Start a black-hole proxy on 127.0.0.1 forwarding to `upstream` (e.g. the cluster's Unix socket).
    - Types: `BlackHoleProxy`

<!-- AUTOGENERATED:END -->
