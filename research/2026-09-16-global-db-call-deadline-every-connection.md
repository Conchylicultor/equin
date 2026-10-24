# A deadline on every database call, on every connection

## Context

On 2026-09-15 on main, the job `tasks.maybe-launch` (job 1356086) waited 2.5 h
on a database call that never answered. Postgres was idle: no query running, no
lock held. The only alerts were about the job (deadline exceeded, zombie, slot
hog). Nothing named the connection, the pool, the SQL or the caller.

Evidence: the "Stray fd close hunt" page → "Evidence and ruled-out suspects"
(the 10:20:46, 11:13:00 and 14:15:01 sightings). The most likely hung call was
the job queue's enqueue, on a pool that connects straight to Postgres.

Why nothing caught it:

- Only the app pool behind `db` has a deadline (60 s,
  `plugins/database/server/internal/query-deadline.ts`, wired in `client.ts`
  `installQueryWrapper` / `armLease`), and its clock starts once a connection is
  handed out. **Opening a connection has no bound on any pool.**
- Every other backend connection has no deadline at all:
  | connection | where | target |
  |---|---|---|
  | job runners pool | `infra/jobs/server/internal/worker.ts` `getRunnerPool` | direct |
  | job enqueue (worker-utils) | `worker.ts` `getWorkerUtils` — graphile builds its own pool from `connectionString` | direct |
  | queue-schema installer | `jobs/server/internal/queue-schema.ts` | direct |
  | job-lock pool | `jobs/server/internal/job-lock.ts` `lockPool` | direct |
  | admin pool + short-lived clients | `database/plugins/admin/server/internal/pool.ts` | direct |
  | change-feed LISTEN client | `database/plugins/change-feed/server/internal/listener.ts` | direct |
- The health report's Database row reads only app-pool deadline hits.

The root cause that day (Bun 1.3.13 double-closing Chromium's pipe fds) is
fixed by Bun 1.4.2. This plan is about the *next* silent connection, whatever
causes it: it must fail the caller, and it must be reported by pool, phase, SQL
and caller.

## Outcome

- Any database call — **opening a connection** or **a query** — on **any
  backend connection** that gets no reply within its bound rejects the caller
  and abandons the connection (never closes it: the fd number may already
  belong to someone else).
- Each one files a `db-query-deadline` report and lights the health report's
  Database row, naming **the pool** (`app`, `jobs-runner`, `jobs-enqueue`,
  `job-lock`, `admin`, `change-feed`, …), **the phase** (connect / query), **the
  SQL**, and **the caller** (the runtime-profiler entry — for the incident, the
  job `tasks.maybe-launch`).
- A new backend connection cannot be created without the deadline: a lint rule
  bans raw `new pg.Pool` / `new pg.Client` / graphile `connectionString` in
  backend code.

## Design

### 1. Put the clock on the connection, not on the pool

Today the clock lives in the app pool's wrapper around `pool.query` and
`pool.connect`. That shape cannot reach graphile-worker, which checks clients
out itself (`withPgClient` → `pgPool.connect()`, and the callback form for its
LISTEN connection), nor a standalone `pg.Client`.

Every one of those paths ends in the same two methods of a `pg.Client`:
`connect()` and `query()`. `pg.Pool` takes a `Client` class option, and a
standalone client is just `new Client`. So the clock moves into **one `pg.Client`
subclass**, and every pool and client is built with it:

- `query()` (promise form, not a Submittable/callback form — same exclusions as
  today's `isUnwrappableQuery`): armed at the call, bound from
  `currentQueryDeadline()` (the existing `withQueryDeadline` scope, now honoured
  by every connection).
- `connect()`: armed at the call, same default bound (60 s — equal to Postgres's
  own `authentication_timeout`, the value the migrations check already settled
  on in `migrations/check/internal/direct-db.ts`).
- On expiry: the call rejects with `QueryDeadlineExceededError` (gains `pool`
  and `phase`), the client is marked **lost**, later calls on it reject at once,
  permanent no-op `error`/`end` listeners are attached, it goes into the
  existing `AbandonedClientHold`, a `[deadline]` line goes to `db.jsonl`, a
  `<sql>[deadline]` span is recorded, and the event is emitted on
  `queryDeadlineSink`.
- `origin` is captured synchronously at the call (`currentEntryLabel()`), as
  today.

Why not pg's own `connectionTimeoutMillis`: on expiry both pg (`client.js`
`_connect`) and pg-pool (`newClient`) call `stream.destroy()` — they close the
fd, which is exactly what the abandon rule forbids.

**Connect inside a pool.** pg-pool calls `client.connect(cb)`. When our connect
deadline fires we call `cb(err)` once (a late real completion is dropped).
pg-pool's own error path then removes the client from `_clients`, pulses the
queue and fails the waiting checkout — **without** ending the client. One
detail to handle: pg-pool attaches its idle `error` listener before checking
`err`, and that listener would end the client, so the subclass removes it when
it abandons.

**Lost client inside a pool.** A query deadline on a checked-out client needs
the existing `abandonClient(pool, client)` (detach from `_clients`/`_idle`,
pulse). The factory gives each client a back-reference to its pool, and wraps
`release()` so releasing a lost client is a no-op (today `armLease` does this
for the app pool only). This matters for `withJobLock`, which calls
`release(true)` on uncertain paths — a destroy, which would close the fd.

Queue wait (all connections busy) stays unbounded: that is back-pressure, not a
silent connection, and every held connection now has its own bound that frees
it.

### 2. One way to build a backend connection

New leaf sub-plugin **`plugins/database/plugins/connection`** (server only),
importing only `pg`, `report-sink`, `runtime-profiler/core` and `log-channels`,
so `database`, `admin`, `change-feed` and `jobs` can all import it without a
cycle. It owns:

- `createDbPool({ name, connectionString, max, idleTimeoutMillis?, allowExitOnIdle? })`
  and `createDbClient({ name, connectionString })`.
- The contents of today's `database/server/internal/query-deadline.ts` (moved,
  not copied): `QUERY_DEADLINE_MS`, `BOOT_DDL_QUERY_DEADLINE_MS`,
  `QueryDeadlineExceededError`, `withQueryDeadline`, `currentQueryDeadline`,
  `queryDeadlineSink`, `abandonClient`, `AbandonedClientHold`,
  `assertPgPoolInternals`. Importers (`database/server`, `change-feed`,
  `query-deadline`, `barrel-import` stubs) switch to the new barrel — no
  re-export.
- `name` is a closed union of pool names in its `core` (`"app" | "jobs-runner" |
  "jobs-enqueue" | "jobs-schema" | "job-lock" | "admin" | "admin-short-lived" |
  "change-feed"`) — a closed list, so plain data rather than a slot.

### 3. Move every backend connection onto it

- **App pool** (`database/server/internal/client.ts`): `pool()` uses
  `createDbPool({ name: "app" })`. `installQueryWrapper` keeps what only the app
  pool has — lane gates, deadlock retry, `[acquire]` spans — and loses its own
  clock (`runUnderDeadline`, `DeadlineClock`). The lease keeps freeing its
  background-tx gate slot at expiry by subscribing to the client's lost signal.
  One semantic change: a 40P01 retry gets its own clock per attempt instead of
  sharing one. A retry only follows a *reply*, so a hang still costs one bound;
  noted in `database/CLAUDE.md`.
- **Jobs**: runner pool → `createDbPool({ name: "jobs-runner" })`; worker-utils
  → build `createDbPool({ name: "jobs-enqueue" })` and pass `pgPool` (and end it
  in `stopWorkers`, since graphile never ends a pool it was handed);
  queue-schema installer → `jobs-schema`, its graphile migrations under
  `withQueryDeadline(BOOT_DDL…)`; `lockPool` → `job-lock`.
- **Admin**: `getAdminPool` / `openShortLivedClient`. Audit its ~28 call sites
  for statements that legitimately take minutes (`CREATE DATABASE … TEMPLATE`,
  `DROP DATABASE`, fork steps) and wrap those in `withQueryDeadline` with a
  reason, like boot DDL.
- **Change-feed listener**: `createDbClient({ name: "change-feed" })`. A connect
  or `LISTEN` that hangs now rejects into its existing reconnect path.

Out of scope (not backend processes, nothing drains the report sink there, so
the lint rule exempts them by path): CLI (`apply-migrations`, `build` readiness
probes), `check/`, `scripts/`, `e2e/`, `*.test.ts`, the zero-cache sidecar
start script. The debug sentinel's own client runs outside the backend's report
path; it gets a lint disable with that reason.

### 4. Enforce it (lint)

`database/plugins/connection/lint`: `no-raw-pg-connection` — flags `new Pool` /
`new Client` imported from `pg`, and a `connectionString` property passed to
graphile-worker's `run` / `makeWorkerUtils` / `runMigrations`, outside the
connection plugin and the exempt paths above. A future pool cannot skip the
deadline.

### 5. Reports and the health row

`plugins/database/plugins/query-deadline`:

- Payloads (`core/internal/payloads.ts`): `DbQueryDeadlinePayloadSchema` gains
  `pool` and `phase` (defaulting to `"app"` / `"query"` so existing rows still
  parse); `DbAbandonCapPayloadSchema` gains `pool`.
- Fingerprint: `db-query-deadline:${pool}:${phase}:${sql}` (connect has no SQL;
  its label is `[connect]`). Kind id unchanged, still `duressExempt`.
- Hit ring / `db-query-deadlines` resource: hits carry `pool`, `phase`,
  `origin`.
- Database row (`web/internal/database-health.ts`): counts every pool. Message
  names the latest: *"2 database calls got no reply in the last 10 min — last:
  jobs-enqueue, issued by tasks.maybe-launch, at 10:21"*.
- Debug → Reports summary (`query-deadline-summary.tsx`): pool + phase badges
  beside the SQL and the caller.
- Investigation task text (`render.ts`): for direct pools, point at
  `postgres.log` rather than the pgbouncer log.

### Not in this plan

- A silent LISTEN socket with no call pending (change-feed, graphile's LISTEN
  connection) has nothing waiting for a reply, so no deadline sees it. It needs
  a heartbeat. I'll file it as a follow-up task.
- A call stack on the report. The caller is named by the profiler entry label;
  capturing a stack on every query is a hot-path cost for little gain over that.

## Critical files

- new `plugins/database/plugins/connection/{server,core,lint}/…` + `CLAUDE.md`
- `plugins/database/server/internal/{client.ts,query-deadline.ts→moved}`,
  `query-deadline.test.ts` (moved and extended), `plugins/database/CLAUDE.md`
- `plugins/infra/plugins/jobs/server/internal/{worker.ts,job-lock.ts,queue-schema.ts}`,
  `plugins/infra/plugins/jobs/CLAUDE.md`
- `plugins/database/plugins/admin/server/internal/pool.ts` + long-statement call sites
- `plugins/database/plugins/change-feed/server/internal/listener.ts`
- `plugins/database/plugins/query-deadline/{core,server,web}/…`

## Verification

1. Tests (`./equin test plugins/database plugins/infra/plugins/jobs`),
   against the existing black-hole proxy in `query-deadline.test.ts`:
   - query hang on a direct pool → rejects within the bound, client detached,
     pool builds a replacement, fd not closed;
   - **connect hang** (proxy accepts TCP, never answers the startup packet) on a
     pool and on a standalone client → rejects, waiting checkout fails,
     `_clients` does not keep the dead client, no `end()` called;
   - graphile `addJob` through a `jobs-enqueue` pool behind the proxy → rejects
     with pool `jobs-enqueue` and the caller's origin;
   - `release(true)` on a lost `job-lock` client is a no-op;
   - `withQueryDeadline` widens a direct-pool call;
   - app-pool lease still frees its tx gate slot at expiry;
   - web verdict: message names pool and caller; old payloads without pool parse.
   - lint rule tests: raw `new Pool` in `server/` flagged; in `*.test.ts` / `cli/` not.
2. `./equin build` (runs checks incl. type-check, eslint, plugin boundaries,
   docs in sync).
3. Live check on this worktree's deploy: the backend boots, jobs run, the
   change-feed reconnects, and Debug → Reports shows no new deadline reports
   (no false positives from the admin/fork paths — run a worktree fork once).
   A real hang can't be produced on demand in the deployed backend (a script
   run separately has no report sink draining), so the report and the health
   row are proven by the handler and web verdict tests in step 1.
