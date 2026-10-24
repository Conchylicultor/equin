# A lost DB query can no longer freeze the app silently

Plan. Companion to the incident report
[`2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`](2026-09-11-global-live-updates-frozen-by-stray-fd-close.md).

## Context

On 2026-09-11 a pooled Postgres socket on main was closed underneath a running query
(a stray fd close — root cause tracked separately in task `task-1789128543757-yp8dvf`).
`pg` got no event. With no query timeout anywhere, the query waited forever. It sat
inside a live-state flush, and flushes run one at a time, so no DB change reached any
tab for 25+ minutes. Nothing alerted, and the health dot stayed green.

Outcome wanted:

1. A query whose answer never comes back **fails after a deadline**. The app recovers
   by itself: the flush gets a normal loader error and the next flush drains
   everything queued.
2. That failure is **reported** (Reports + bell) and shown in the **health dot**.
3. **Any** operation stuck too long (DB or not) raises an alert while it is still
   stuck. A report filed only on completion can never fire for a hang.
4. The health dot says so when **live updates are stalled**, even while the update
   channel is the broken part.

## Part 1 — Query deadline in the app pool

File: `plugins/database/server/internal/client.ts` (`installQueryWrapper`, `pool()`).
Scope: the shared app pool behind `db` (the one that hung). Out of scope: the admin
pool, graphile-worker's pool, `lockPool` (holds sessions by design), and the
change-feed LISTEN client (see Follow-ups).

- **Both query paths get the deadline:** the wrapped `pool.query`, AND queries on a
  client leased from the wrapped `pool.connect` (the `db.transaction()` path, which
  today bypasses the wrapper's timing). Wrap the leased client's `query` at the same
  site where the lease already patches `release`.
- **The clock covers the whole call, retries included.** Arm it around the outer
  `retryUntil(…)` (40P01/40001 retry), not per attempt, and keep a mutable ref to the
  attempt's live client so expiry poisons the right one. It covers execution after
  acquire; acquire already has its gates.
- **Default 60 s.** Boot DDL opts into a longer bound through an explicit scope:
  `withQueryDeadline({ ms, reason }, fn)`, an `AsyncLocalStorage` local to
  `client.ts` (independent of the runtime-profiler's stores). Call sites: the
  migrations runner, the derived-tables and derived-views rebuilds, and the
  change-feed trigger rebuild (~15 min; they can wait on hot-swap locks).
- **On expiry**, the caller's promise rejects with a typed `QueryDeadlineExceededError`
  (sql label, elapsed, bound, origin entry label, `leased: boolean`). No `.code`
  field, so `retryableSqlState` never retries it. A synthetic
  `recordSpan("db", "<sql>[deadline]", elapsed)` is emitted so the timeline shows it.
- **The connection is ABANDONED, never closed.** In the stray-close failure, the
  socket's fd number is already free and is probably reused by something else by the
  time the deadline fires. Closing it (`client.end()`, which pg-pool's `_remove`
  always calls) would kill that other resource — a new victim, possibly another pg
  socket, so a cascade every 60 s. One function, `abandonClient(pool, client)`, does
  all of this in one step:
  1. attaches permanent no-op `error`/`end` listeners. Without them, a later socket
     error on the detached client is an unhandled `'error'` event that crashes the
     process;
  2. removes the client from pg-pool's `_clients` and `_idle` (clearing its idle
     timer), so `totalCount` drops and the pool builds a replacement on demand. This
     reaches into pg-pool 3.13 internals — there is no public detach-without-end.
     A test pins the behavior;
  3. holds a strong reference in a capped module set (32), so GC finalization can
     never close the fd later. Going over the cap is itself reported.
  Cost for a genuinely slow-but-alive query: one leaked pgbouncer client connection.
  A late reply can only resolve the already-rejected promise, a no-op, because pg-pool
  never hands the client out again.
- **Transactions:** a poisoned leased client's release detours into `abandonClient`,
  wrapping the lease's *already-patched* `release`. Drizzle's argless `release()`
  must still free the `backgroundTxGate` slot, or each incident leaks a slot.
  `runOnce`'s bare `finally { client.release() }` becomes: release on completion,
  abandon on expiry.
- **Emit to a database-owned seam**, `queryDeadlineSink`, built on
  `primitives/report-sink` (`defineReportSink`: fire-and-forget, holds early
  emissions). The reports plugin depends on `database`, so the database plugin cannot
  file reports itself. The same shape is used by `jobs` → `jobs/deadline-audit`.

## Part 2 — Report + "Database" health row

New sub-plugin `plugins/database/plugins/query-deadline/`, modeled on
`plugins/infra/plugins/jobs/plugins/deadline-audit`:

- **server** — registers the `queryDeadlineSink` handler. It files report kind
  `db-query-deadline` (`ReportKind` spec, `duressExempt: true`, fingerprint = sql
  label, `renderTask` pointing at the incident doc). It also keeps an in-memory ring of
  recent hits (last 20: at, sql label, elapsed), served as a small push-mode resource
  `db-query-deadlines`. That's a schema-bounded scalar, allowed under the
  bounded-resource rule.
- **web** — `Reports.KindView` for the one-line summary, plus
  `HealthReport.Row({ kind: "status", id: "database", title: "Database" })`.
  Status is `attention` when a hit landed in the last 10 min: "2 database queries
  lost in the last 10 min — last at 12:01". Otherwise `ok`, and `unknown` while
  pending. The 10-min expiry is one scheduled `setTimeout` to the expiry instant, not
  polling.
- This row can ride live-state safely: the deadline unfreezes the flush within 60 s,
  and the notify lands right after the hit. The "stalled right now" case is Part 3's
  job.

The loader that hit the deadline also fails through the existing
`reportLoaderError → reportServerError` path, which files a generic crash row.
That's accepted: the dedicated kind carries the diagnosis.

## Part 3 — "Live updates stalled" in the Connection row

The one signal that must reach the tab *while* pushes are stuck: during the incident,
the server's heartbeat pings kept flowing while the flush was frozen.

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`: stamp
  `flushStartedAt` when `flushNotifies` takes the mutex, and clear it in `finally`.
  The heartbeat (`notificationsWsHandler.open` →
  `{ kind: "ping" }`) becomes `{ kind: "ping", flushOpenMs }`. That age is the
  runtime's own fact, so there's no layering leak.
- `plugins/primitives/plugins/live-state/web/notifications-client.ts`: the ping branch
  stores `flushOpenMs` in the per-channel status read by
  `useNotificationsChannelStatuses`. Missing ⇒ 0, so old/new skew is harmless; the
  envelope has no zod schema. Pings already fan out from the leader tab to followers.
- `plugins/infra/plugins/health/web/internal/use-connection-health.ts`: socket open
  and `flushOpenMs ≥ 30 s` ⇒ `critical`, "Connected, but live updates have been stuck
  for 3 min — changes are saved but won't appear until the server restarts".
  Detection ≤ 30 s + one heartbeat interval.

## Part 4 — Stuck-operation alert (any kind of hang)

New `plugins/debug/plugins/stuck-spans/` (server only, plus a `Reports.KindView`):

- A raw `setInterval` (15 s) started in `onReady`, stopped in `onShutdown`. It's
  deliberately **not** `defineJob`: a monitor must not run through the machinery it
  watches (doctrine in `plugins/debug/plugins/queue-health/server/internal/watchdog.ts`).
- Each tick reads the runtime-profiler's open entries (`captureFlightWindow`, open
  list, `ageMs`). Any `http` / `sub` / `loader` / `push` / `flush` / `cascade` entry
  open longer than its threshold (60 s; `http` 120 s) files report kind `span-stuck`
  **once per span id**, with a `captureTrace` so the Gantt of everything in flight is
  attached. `job` is excluded: it has its own deadline audit. `bg` is excluded at
  first, because some bg spans are long by design.
- `duressExempt: true` (once-per-span already bounds volume).

Why this is not the same as Part 1: Part 1 bounds and *recovers* one kind of wait
(the database). Part 4 *detects* any wait that never ends — a git or tmux child, a
lock, a network call, a promise a bug never settles. It detects but doesn't recover.

## Follow-ups (not in this plan)

- The change-feed LISTEN client can die the same silent way. Its liveness watchdog
  only checks that the object exists. Give it a real round-trip probe.
- A flush that is stuck on something *other* than a DB query stays stuck; Part 4
  only reports it. Recovery would need a per-drain deadline that forfeits, like
  the jobs deadline.
- The pgbouncer log is 530 MB with no rotation.

## Critical files

- `plugins/database/server/internal/client.ts` — deadline, `withQueryDeadline`,
  `abandonClient`, sink emission
- `plugins/database/plugins/{migrations,derived-tables,derived-views,change-feed}/server/internal/*` —
  wrap boot DDL in `withQueryDeadline`
- `plugins/database/plugins/query-deadline/` — new: report kind, ring resource,
  Database row, KindView
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — `flushStartedAt`,
  ping payload
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` + the channel
  status store; `plugins/infra/plugins/health/web/internal/use-connection-health.ts`
- `plugins/debug/plugins/stuck-spans/` — new watchdog + kind

Reuse: `defineReportSink` (primitives/report-sink), `ReportKind` / `recordReport`
(reports), `HealthReport.Row` (shell/health-report), `captureFlightWindow` /
`captureTrace`, and the queue-health watchdog shape.

## Verification

- **DB-backed tests** (`./equin test plugins/database`), through a black-hole
  socket proxy in front of the cluster (forwarding can be switched off to swallow
  bytes). An injected short deadline asserts:
  - `pool.query` rejects with `QueryDeadlineExceededError` and the next query succeeds
    on a fresh connection;
  - `client.end` is never called on the abandoned client, it is gone from `_clients`,
    and a later socket error does not crash the process;
  - the sink fires exactly once;
  - a hang inside `db.transaction()` rejects, the `backgroundTxGate` slot is freed and
    the client is abandoned;
  - the retry loop does not restart the clock;
  - `withQueryDeadline` extends the bound.
- **resource-runtime test** (existing fake-socket harness): a loader that never
  settles ⇒ pings report a growing `flushOpenMs`, and `0` once it settles.
- **jsdom tests**: the Connection row turns critical on a stalled `flushOpenMs`; the
  Database row goes attention and then back to ok after 10 min (pinned clock).
- **Stuck-spans test**: a fake open entry past its threshold files once, not every tick.
- **Deployed**: `./equin build`. Then the read-only WS probe used in the incident:
  pings carry `flushOpenMs: 0`, and a write still produces a `delta`. Screenshot the
  health dot with `screenshot.ts`. `./equin check` passes, including
  `plugin-boundaries`: the new sub-plugins import `reports` and `database`, and
  `database` imports neither.
