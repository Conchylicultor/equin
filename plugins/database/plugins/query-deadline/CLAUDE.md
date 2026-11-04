# query-deadline

Makes a lost database call visible. When a call on any backend connection gets
no answer before its deadline — opening the connection, or a query on it — the
connection plugin fails the caller and closes the connection; this plugin
turns that into a report (Debug → Reports + the bell) and into the health
report's **Database** row.

Every backend connection is built by `database/connection` and names itself
with one of the closed set of pool names (`DB_POOL_NAMES` in its `core`). Every
report, ring hit and row message carries that name:

| pool | what it is | reaches Postgres through | log to read |
| --- | --- | --- | --- |
| `app` | the interactive lane's pool behind `db` | pgbouncer | `PGBOUNCER_LOG_FILE` |
| `app-background` | the background lane's pool behind `db` | pgbouncer | `PGBOUNCER_LOG_FILE` |
| `jobs-runner` | graphile-worker's job-running pool | the direct socket | `PG_LOG_FILE` |
| `jobs-enqueue` | graphile-worker's `WorkerUtils` pool (`addJob`) | the direct socket | `PG_LOG_FILE` |
| `jobs-schema` | the boot-time job-queue schema installer | the direct socket | `PG_LOG_FILE` |
| `job-lock` | the advisory-lock pool behind `withJobLock` | the direct socket | `PG_LOG_FILE` |
| `admin` | the admin pool (maintenance database) | the direct socket | `PG_LOG_FILE` |
| `admin-short-lived` | one-off admin clients around a single operation | the direct socket | `PG_LOG_FILE` |
| `lock-watch` | the lock watch's held session | the direct socket | `PG_LOG_FILE` |
| `change-feed` | the change-feed LISTEN client | the direct socket | `PG_LOG_FILE` |

The investigation task points at the log in the last column: a stray close
shows up at the other end of the socket — as an EOF while the call was still
waiting, before the deadline's own close at its expiry — and only the app's lane pools have
pgbouncer at the other end (`DB_POOLS_THROUGH_PGBOUNCER`). Both paths are imported as constants (`database/pgbouncer`,
`database/embedded`), never spelled.

Each call is in one of two phases: `connect` (opening the connection; its label
is `[connect]`, there is no SQL) or `query`.

Background: [`research/2026-09-11-global-query-deadline-and-stall-health.md`](../../../../research/2026-09-11-global-query-deadline-and-stall-health.md)
(Part 2) and the incident it answers,
[`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`](../../../../research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md).

## Why it is a sub-plugin and not part of `database`

`reports` imports `database` (it writes its rows through `db`), so `database`
cannot file reports without a cycle. The database plugin owns the mechanism —
the deadline, closing a lost connection, and the `queryDeadlineSink` seam it emits to — and
this plugin owns the interpretation. Same split, same reason, as
`infra/jobs` → `infra/jobs/deadline-audit`. The child imports the parent
(`queryDeadlineSink`, `QueryDeadlineEvent` from `@plugins/database/plugins/connection/server`); the
parent never imports the child.

The seam is a fire-and-forget `defineReportSink`, registered in `onReady` and
cleared in `onShutdown`. It holds what is emitted before registration, so a
deadline that fires during boot is replayed rather than lost.

## The kind

`db-query-deadline`: one row per pool + phase + caller (origin), or the query
label when there is no caller (per worktree); fires when a call got no answer
before its deadline and its connection was closed. `variant: "error"`,
`duressExempt: true`, re-alerts the bell at most every 10 minutes per row.
Source is `server-caught`: the deadline is an error caught in-process, not a
monitor's finding.

A second kind, `db-abandon-cap`, is **retired**: it fired while lost
connections were abandoned into a hold set capped at 32, and nothing files it
since they are closed (2026-11-04). It stays registered — schema, task renderer
and list summary — so its existing rows still validate, render and can be
investigated (the `reports/turn-unconfirmed` precedent).

**Fingerprints.** `db-query-deadline:${pool}:${phase}:origin=${origin}`, or
`…:sql=${sql}` for a call with no origin (boot, migrations) — `queryDeadlineKey`
in `server/internal/render.ts`. By caller, not statement: one caller loses
calls under many labels (an `in ($1, $2, …)` list is a new label per arity, a
transaction is several statements), and keyed by label the 2026-11-03 incident
spread one cause over dozens of rows. The upsert refreshes `data`, so the
payload is the caller's latest lost call. The pool is in it because the same
caller on two pools is two different sockets with two different logs; the
phase because a failed connect and an unanswered query are different facts.
Rows filed under the old per-label fingerprint (`…:${sql}`) stay as they were.

**Old rows still parse.** Rows filed before every connection had a deadline
have no `pool` / `phase` (and may carry a since-removed `leased` flag, or the
`abandoned` hold count rows carried until 2026-11-04). The payload schema
defaults them to `app` / `query` — which is what they all were — and strips
the rest.

**`duressExempt`.** A lost query and a host in trouble are often the same
event. Without the flag the reports funnel would shed exactly the reports that
describe the outage. Volume stays bounded without the gate: each lost query
costs a full deadline, and repeats dedupe onto their row.

**No renderer restates a bound.** Every duration printed — the wait, the
deadline — arrives in the payload from the database plugin. A report records
what was true when it was filed; re-deriving `60s` at render time would let an
edit to the default silently rewrite past reports.

**Kind strings are spelled once**, in `core/` (`DB_QUERY_DEADLINE_KIND`,
`DB_ABANDON_CAP_KIND`), and used by both the server's `ReportKind` and the web's
`Reports.KindView`, so the two cannot drift apart.

## What a `db-query-deadline` report carries

The report is there to surface the CAUSE, not only that a call was lost
(`research/2026-11-04-global-db-connection-failure-vision.md`, point 4). Beside
pool, phase, SQL, caller and elapsed vs bound, the seam event carries what the
connection plugin knew at the expiry instant, before it touched anything:

- **`transaction`** — the lost connection's state as of its last reply
  (`idle` / `open` / `failed`; null for a connect). `open` means the call was
  sent inside a transaction, which closing the connection rolled back (until
  2026-11-04 the connection was abandoned instead, and the transaction stayed
  open with its row locks — the 2026-11-03 head of chain).
- **`inFlight` / `inFlightCount`** — every call then pending on this
  process's OTHER connections (pool, phase, SQL, caller, age, transaction
  state), the `IN_FLIGHT_REPORT_MAX` oldest kept: in a lock chain the waiters,
  and the head among them. Calls queued on the lost connection itself are left
  out — pg sends one statement at a time, so they never reached the server.
  The cap is the emitter's; the schema does not re-check it, so a row filed
  under an older cap still parses.
- **`traceId`** — a trace (`debug/trace`) of everything in flight then
  (spans, gates, host and Postgres contention), captured `critical` and
  labelled by pool + phase: one per pool per cooldown however many callers
  lose calls together, which also bounds the loop a trace's own (lost) write
  could feed. A miss within one deadline of the label's latest trace links it
  (its wait overlapped that instant), so a burst never overwrites the link with
  null; a later miss with no trace of its own links none. A throw out of the
  capture is reported on its own and the report still files. On a database
  that is not answering, the trace's own insert can be lost too: the link
  then opens nothing, and the payload's own fields are the evidence.

Rows filed before these fields parse with "not recorded" defaults (null), never
with a value that would claim nothing was waiting.

The task body leads with this evidence, then points at the lock-chain runbook
before the stray-close hunt. The Reports-list summary shows `in tx`, the
waiting count and a View-trace chip.

## The ring and the `db-query-deadlines` resource

The server keeps the last 20 deadline hits (`{ at, pool, phase, sql, origin,
elapsedMs }`, oldest first, from every pool) in memory and serves them as the
`dbQueryDeadlines` `liveValue` (`core/internal/resources.ts`), pushed and served
on the **external** arm — `serveValue(dbQueryDeadlines, { source: "external" })`
as `dbQueryDeadlinesServed` (`server/internal/resource.ts`). Its truth is
process memory, which the change-feed cannot observe, so every hit calls
`dbQueryDeadlinesServed.notify()`. The bound is part of the contract:
`QueryDeadlinesSchema` refuses a longer list, which makes the value a
schema-bounded scalar under the bounded working-set rule. It resets when the
backend restarts; the durable record is the report. The web reads it with
`useLive(dbQueryDeadlines)`; there is no placeholder, so the row is `unknown`
until the first read lands.

On a hit the handler first appends the durable `[deadline] pool=… phase=…` line
to `db.jsonl` (`dbLog` from `database/server`; the connection plugin cannot
import log-channels), then pushes the ring, and only then starts the report
write. The line and the row must land even when the report write is the query
that cannot reach the database.

The push rides the same live-state flush that a lost query can freeze. That is
safe: the deadline is what unfreezes the flush, and the hit's notify is queued
right behind it. The "stalled right now" case belongs to the Connection row
(Part 3 of the plan), not here.

**Accepted feedback loop.** If the database itself stops answering, the report
write for one lost query can itself be lost 60 s later and file another. That is
at most one write per deadline per chain, deduped onto the same row, and it
describes a genuinely broken database — so it is left alone rather than
special-cased.

## The Database row

`HealthReport.Row({ kind: "status", id: "database", order: 20 })`, right after
Connection (10). It reads two values: this plugin's deadline ring (a fading
10-minute window of past events) and `database/lock-watch`'s `db-lock-watch`
(the lock watch's latest look — the state NOW). States:

- either value not loaded yet → `unknown` (pulsing, "Checking…"). Never `ok`
  before the data is read. Otherwise each read gives a part, and the row is the
  worse of the two, its summary every part that is not `ok` (the lock watch's
  first) — so a failed read of one never hides what the other knows:
- the lock watch: a session holding others back → `critical`, "Blocked now:
  conversations.usage:sync holds 15 sessions (longest wait 4 min), idle in its
  transaction for 5 min — as of 10:21"; one idle in its transaction →
  `attention`, "Now: … has sat idle in its transaction for 3 min — as of 10:21";
  not looked yet → `unknown`; latest look older than `LOCK_WATCH_STALE_MS`
  (3 min) → `attention`, "The lock watch has not looked since 10:21"; failed
  to load → `unknown`.
- the deadline ring: a hit on any pool in the last 10 min → `attention`,
  counting them and naming the latest: "2 database calls got no reply in the
  last 10 min — last: jobs-enqueue, issued by tasks.maybe-launch, at 10:21"
  (singular: "1 database call got no reply in the last 10 min — jobs-enqueue,
  issued by …, at 10:21"). A connect reads "opening a jobs-enqueue
  connection"; an unknown caller is left out. Failed to load → `unknown`.
- both `ok` → "No unanswered database calls in the last 10 min; no session
  holding others back (as of 10:21)".

## The Reports list

A `db-query-deadline` row reads `[pool] [phase] [sql] no answer for 60s —
closed · issued by <origin>`: the pool as a muted mono chip, the phase as a
chip (`connect` in warning colour), the query label as a destructive mono chip
(left out for a connect, which has none), and the caller muted at the end;
then an `in tx` warning chip when the call was sent inside a transaction, "· N
other calls waiting", and a View-trace link chip onto Debug → Slow Events.

Time moves the verdict by itself, so the hook keeps `now` as state and schedules
**one** `setTimeout` to the next instant the verdict changes — the moment the
oldest in-window hit turns 10 minutes old, or the lock watch's look goes
stale — re-arming after each step until
nothing is left to expire. No interval, no polling. The timer never steps `now`
short of the instant it waited for, or a verdict left unchanged would leave the
effect with no timer to fire again.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Query-deadline presence: the health report's Database row (attention while a database call on any pool got no reply in the last 10 minutes, naming the latest's pool and caller, read from the db-query-deadlines push resource) and the one-line Debug → Reports summaries (pool, phase, query, caller) for the db-query-deadline kind and the retired db-abandon-cap kind (kept so its old rows still render). Query-deadline audit: registers a handler on the database plugin's query-deadline seam and turns each announcement into a report — db-query-deadline (error, one row per pool, phase and caller — the query label when there is no caller) when a call on any backend connection — opening it or a query on it — got no answer before its deadline and its connection was closed, carrying the connection's transaction state, every other call then in flight, and a link to a trace of that instant; the retired db-abandon-cap kind (filed while lost connections were abandoned) stays registered so its old rows still render and can be investigated — and keeps the last 20 hits in memory as the db-query-deadlines push resource behind the health report's Database row.
- Web:
  - Contributes:
    - `Reports.KindView` → `QueryDeadlineSummary`
    - `Reports.KindView` → `AbandonCapSummary`
    - `HealthReport.Row` "Database"
  - Uses:
    - `debug/trace/engine.TraceChip`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
    - `shell/health-report.HealthReport`
- Server:
  - Contributes:
    - `report-kind` "db-abandon-cap"
    - `report-kind` "db-query-deadline"
    - `resource.declare` "db-query-deadlines"
  - Uses:
    - `database.dbLog`
    - `database/connection.formatDeadlineLogLine`
    - `database/connection.QueryDeadlineEvent`
    - `database/connection.queryDeadlineSink`
    - `database/embedded.PG_LOG_FILE`
    - `database/pgbouncer.PGBOUNCER_LOG_FILE`
    - `debug/trace/engine.captureTrace`
    - `network/live.serveValue`
    - `reports.ReportKind`
    - `reports.ReportRow`
    - `reports/engine.recordReport`
  - Exports (values):
    - `abandonCapKind`
    - `queryDeadlineKind`
  - Resources: `db-query-deadlines` (push, notified)
- Core:
  - Uses:
    - `database/connection.DB_CALL_PHASES`
    - `database/connection.DB_POOL_NAMES`
    - `database/connection.DB_TX_STATES`
    - `network/live.liveValue`
  - Exports (types):
    - `DbAbandonCapPayload`
    - `DbQueryDeadlinePayload`
    - `InFlightDbCall`
    - `QueryDeadlineHit`
    - `QueryDeadlines`
  - Exports (values):
    - `DB_ABANDON_CAP_KIND`
    - `DB_QUERY_DEADLINE_KIND`
    - `DbAbandonCapPayloadSchema`
    - `DbQueryDeadlinePayloadSchema`
    - `dbQueryDeadlines`
    - `InFlightDbCallSchema`
    - `QUERY_DEADLINE_RING_CAPACITY`
    - `QueryDeadlineHitSchema`
- Cross-plugin:
  - Uses tokens: `ui/tokens/color-palette --muted-foreground`

<!-- AUTOGENERATED:END -->
