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
- **Not pg's `connectionTimeoutMillis`.** On expiry both pg and pg-pool call
  `stream.destroy()`. That closes the fd, which the abandon rule forbids.
- **Queue wait is not bounded.** Waiting for a free connection is back-pressure,
  and every held connection has its own bound that frees it.

## What happens when a call gets no reply

The caller gets a `QueryDeadlineExceededError`: `pool`, `phase`
(`connect` | `query`), `sql` (the query's profiler label, or `[connect]`),
`elapsedMs`, `deadlineMs`, `origin` (the runtime-profiler entry, `null` when
context-less) and `reason` (the scope's, `null` under the default). It has no
`.code`, so the app pool's deadlock retry never re-runs a lost statement.

The client is then **lost**, for good:

1. **Abandoned, never closed** (`abandonClient`, `server/internal/abandon.ts`).
   By the time the deadline fires, the lost socket's fd number may already
   belong to something else, so closing it would close an innocent resource.
   Instead: permanent no-op `error` / `end` listeners, removal from pg-pool's
   `_clients` / `_idle` plus a queue pulse so a replacement is built, and a strong
   reference in a hold capped at 32 (`ABANDON_HOLD_CAP`; past it, an
   `abandon-cap` event). This reaches into pg-pool 3.13 internals — asserted at
   pool build (`assertPgPoolInternals`) and pinned by `deadline.test.ts`.
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
4. **`release()` and `end()` do nothing.** pg-pool turns `release(err)` and
   `release(true)` into `client.end()`, which closes the fd. `withJobLock` calls
   `release(true)` on uncertain paths. pg-pool assigns `release` on every
   checkout, so `DbClient` takes it through an accessor, and a lost client's
   release is a no-op however it was checked out.
5. **`onClientLost(client, fn)` subscribers are told**, synchronously. A lease
   owner uses it to end bookkeeping tied to the connection: the app pool frees
   its background-transaction gate slot there.

**A connect that times out inside a pool.** The deadline hands the error to
pg-pool's connect callback first. pg-pool drops the client from `_clients`,
pulses the queue and fails the waiting checkout — without ending the client. But
that callback attaches the pool's idle `error` listener before it checks the
error, and that listener ends the client when it fires. So whatever `error`
listener the callback attached is removed again before the client is abandoned.

A late real reply (a slow call, not a lost one) is dropped: its call was already
settled. The cost is one leaked server connection until the backend restarts.

## Pool names

A closed list in `core` (`DB_POOL_NAMES`, `DbPoolName`) — plain data both
runtimes read, not a slot:

| name | connection | built in |
| --- | --- | --- |
| `app` | the app pool behind `db` (through pgbouncer) | `database/server` `client.ts` |
| `jobs-runner` | graphile-worker's job-running pool, shared by the three runners | `infra/jobs` `worker.ts` |
| `jobs-enqueue` | graphile-worker's `WorkerUtils` pool (`addJob`), handed over as `pgPool` | `infra/jobs` `worker.ts` |
| `jobs-schema` | the boot-time job-queue schema installer (boot-DDL bound) | `infra/jobs` `queue-schema.ts` |
| `job-lock` | the advisory-lock pool behind `withJobLock` | `infra/jobs` `job-lock.ts` |
| `admin` | the admin pool (fork, drop, list) | `database/admin` `pool.ts` `getAdminPool` |
| `admin-short-lived` | one-off pools opened and closed around a single operation | `database/admin` `pool.ts` `openShortLivedClient` |
| `change-feed` | the change-feed LISTEN client | this plugin's `listen-session.ts` (`openListenSession`), opened by `database#machine`'s `DatabaseDriver.listen` for `database/change-feed`'s `listener.ts` |
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

**In a CLI process** (`./singularity build`, `db fork`, `deploy` open admin
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

`database/server` (the app pool), `database/admin`, `database/change-feed` and
`infra/jobs` all build connections, and `jobs` sits below plenty of things that
import `database`. So this plugin imports nothing of theirs: only `pg`,
`primitives/report-sink`, `infra/runtime-profiler/core` and
`infra/runtime-identity/core`.

**Never import `primitives/log-channels/server` here.** That barrel carries HTTP
and WS routes, which reach `endpoints` and its DOM-typed codec. Admin connections
are opened from CLI and tools code (`paths/scripts/migrate-data-layout.ts` →
launcher → `database/admin`), and the `tools` type-check target has no DOM lib,
so the import broke it. The `db` channel lives in `database/server`.

## Not covered

A LISTEN connection with no call pending has nothing waiting for a reply, so no
deadline sees it go silent. That needs a heartbeat.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Every backend database connection, built one way: createDbPool / createDbClient give each pool or standalone client a name from the closed pool-name set and a pg.Client subclass that bounds connect() and every query() with a deadline (60 s, widened per scope by withQueryDeadline). A call with no reply rejects with QueryDeadlineExceededError (pool, phase, sql, origin), and its connection is abandoned — detached, held, never closed, since its fd may already be someone else's — and announced on queryDeadlineSink.
- Cross-plugin:
  - Imported by:
    - `database/admin`
    - `database/query-deadline`
    - `infra/jobs`
- Exemptions:
  - Exempts itself from:
    - `db-connection/no-raw-pg-connection` — `.` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/client.ts`, `server/internal/deadline.ts` (debt)
  - Exempted by: `database/connection` (0 debt)
- Server:
  - Exports (types):
    - `CreateDbClientOptions`
    - `CreateDbPoolOptions`
    - `ListenSessionHandlers`
    - `OpenListenSessionOptions`
    - `QueryDeadlineEvent`
  - Exports (values):
    - `ABANDON_HOLD_CAP`
    - `abandonClient`
    - `AbandonedClientHold`
    - `assertPgPoolInternals`
    - `BOOT_DDL_QUERY_DEADLINE_MS`
    - `createDbClient`
    - `createDbPool`
    - `currentQueryDeadline`
    - `formatDeadlineLogLine`
    - `onClientLost`
    - `openListenSession`
    - `QUERY_DEADLINE_MS`
    - `queryDeadlineSink`
    - `queryText`
    - `withQueryDeadline`
- Core:
  - Exports (types):
    - `DbCallPhase`
    - `DbPoolName`
  - Exports (values):
    - `DB_CALL_PHASES`
    - `DB_POOL_NAMES`
- Test helpers:
  - Server: `@plugins/database/plugins/connection/server/testing`
    - `QueryDeadlineExceededError` — A database call got no reply within its deadline.
    - `startBlackHoleProxy` — Start a black-hole proxy on 127.0.0.1 forwarding to `upstream` (e.g. the cluster's Unix socket).
    - Types: `BlackHoleProxy`

<!-- AUTOGENERATED:END -->
