# query-deadline

Makes a lost database call visible. When a call on any backend connection gets
no answer before its deadline — opening the connection, or a query on it — the
connection plugin fails the caller and abandons the connection; this plugin
turns that into a report (Debug → Reports + the bell) and into the health
report's **Database** row.

Every backend connection is built by `database/connection` and names itself
with one of the closed set of pool names (`DB_POOL_NAMES` in its `core`). Every
report, ring hit and row message carries that name:

| pool | what it is | reaches Postgres through | log to read |
| --- | --- | --- | --- |
| `app` | the pool behind `db` | pgbouncer | `PGBOUNCER_LOG_FILE` |
| `jobs-runner` | graphile-worker's job-running pool | the direct socket | `PG_LOG_FILE` |
| `jobs-enqueue` | graphile-worker's `WorkerUtils` pool (`addJob`) | the direct socket | `PG_LOG_FILE` |
| `jobs-schema` | the boot-time job-queue schema installer | the direct socket | `PG_LOG_FILE` |
| `job-lock` | the advisory-lock pool behind `withJobLock` | the direct socket | `PG_LOG_FILE` |
| `admin` | the admin pool (maintenance database) | the direct socket | `PG_LOG_FILE` |
| `admin-short-lived` | one-off admin clients around a single operation | the direct socket | `PG_LOG_FILE` |
| `change-feed` | the change-feed LISTEN client | the direct socket | `PG_LOG_FILE` |

The investigation task points at the log in the last column: a stray close
shows up at the other end of the socket, and only the app pool's other end is
pgbouncer. Both paths are imported as constants (`database/pgbouncer`,
`database/embedded`), never spelled.

Each call is in one of two phases: `connect` (opening the connection; its label
is `[connect]`, there is no SQL) or `query`.

Background: [`research/2026-09-11-global-query-deadline-and-stall-health.md`](../../../../research/2026-09-11-global-query-deadline-and-stall-health.md)
(Part 2) and the incident it answers,
[`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`](../../../../research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md).

## Why it is a sub-plugin and not part of `database`

`reports` imports `database` (it writes its rows through `db`), so `database`
cannot file reports without a cycle. The database plugin owns the mechanism —
the deadline, `abandonClient`, and the `queryDeadlineSink` seam it emits to — and
this plugin owns the interpretation. Same split, same reason, as
`infra/jobs` → `infra/jobs/deadline-audit`. The child imports the parent
(`queryDeadlineSink`, `QueryDeadlineEvent` from `@plugins/database/plugins/connection/server`); the
parent never imports the child.

The seam is a fire-and-forget `defineReportSink`, registered in `onReady` and
cleared in `onShutdown`. It holds what is emitted before registration, so a
deadline that fires during boot is replayed rather than lost.

## The two kinds

Both `variant: "error"`, `duressExempt: true`, and re-alert the bell at most
every 10 minutes per row. Source is `server-caught`: the deadline is an error
caught in-process, not a monitor's finding.

| kind | one row per | fires when |
| --- | --- | --- |
| `db-query-deadline` | pool + phase + query label (per worktree) | a call got no answer before its deadline; its connection was abandoned |
| `db-abandon-cap` | worktree (fixed fingerprint) | the process abandoned more connections than the connection plugin's hold set is sized for |

**Fingerprints.** `db-query-deadline:${pool}:${phase}:${sql}`. The pool is in it
because the same label on two pools is two different sockets with two different
logs, and every connect shares the label `[connect]` — without the pool, the
app pool and a jobs pool failing to connect would merge into one row. The
`db-abandon-cap` fingerprint stays fixed: the hold set and its cap are
process-wide, shared by every pool, so crossing it is one fact about the
process. Its payload's `pool` is the latest abandon's, shown as "latest"; the
per-pool breakdown is the `db-query-deadline` rows.

**Old rows still parse.** Rows filed before every connection had a deadline
have no `pool` / `phase` (and may carry a since-removed `leased` flag). The
payload schemas default them to `app` / `query` — which is what they all were —
and strip `leased`.

Two kinds, not one kind with two fingerprints: they are different facts with
different shapes (one lost query vs. what the lost queries add up to), and one
schema describing both would make every field optional.

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
Connection (10). States:

- resource not loaded yet → `unknown` (pulsing, "Checking…"); failed to load →
  `unknown` "Couldn't load recent database call failures". Never `ok` before the
  data is read.
- a hit on any pool in the last 10 min → `attention`, counting them and naming
  the latest: "2 database calls got no reply in the last 10 min — last:
  jobs-enqueue, issued by tasks.maybe-launch, at 10:21" (singular: "1 database
  call got no reply in the last 10 min — jobs-enqueue, issued by …, at 10:21").
  A connect reads "opening a jobs-enqueue connection"; an unknown caller is
  left out.
- otherwise → `ok`: "No unanswered database calls in the last 10 min".

## The Reports list

A `db-query-deadline` row reads `[pool] [phase] [sql] no answer for 60s —
abandoned · issued by <origin>`: the pool as a muted mono chip, the phase as a
chip (`connect` in warning colour), the query label as a destructive mono chip
(left out for a connect, which has none), and the caller muted at the end. A
`db-abandon-cap` row reads "33 abandoned database connections — over the cap of
32 · latest [pool]".

Time moves the verdict by itself, so the hook keeps `now` as state and schedules
**one** `setTimeout` to the next instant the verdict changes — the moment the
oldest in-window hit turns 10 minutes old — re-arming after each step until
nothing is left to expire. No interval, no polling. The timer never steps `now`
short of the instant it waited for, or a verdict left unchanged would leave the
effect with no timer to fire again.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Query-deadline presence: the health report's Database row (attention while a database call on any pool got no reply in the last 10 minutes, naming the latest's pool and caller, read from the db-query-deadlines push resource) and the one-line Debug → Reports summaries (pool, phase, query, caller) for the db-query-deadline and db-abandon-cap kinds. Query-deadline audit: registers a handler on the database plugin's query-deadline seam and turns each announcement into a report — db-query-deadline (error, one row per pool, phase and query label) when a call on any backend connection — opening it or a query on it — got no answer before its deadline and its connection was abandoned, db-abandon-cap (error, one rolling row) when the abandoned connections exceed the cap — and keeps the last 20 hits in memory as the db-query-deadlines push resource behind the health report's Database row.
- Web:
  - Contributes:
    - `Reports.KindView` → `QueryDeadlineSummary`
    - `Reports.KindView` → `AbandonCapSummary`
    - `HealthReport.Row` "Database"
  - Uses:
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
    - `network/live.serveValue`
    - `reports.recordReport`
    - `reports.ReportKind`
    - `reports.ReportRow`
  - Exports (values):
    - `abandonCapKind`
    - `queryDeadlineKind`
  - Resources: `db-query-deadlines` (push, notified)
- Core:
  - Uses:
    - `database/connection.DB_CALL_PHASES`
    - `database/connection.DB_POOL_NAMES`
    - `network/live.liveValue`
  - Exports (types):
    - `DbAbandonCapPayload`
    - `DbQueryDeadlinePayload`
    - `QueryDeadlineHit`
    - `QueryDeadlines`
  - Exports (values):
    - `DB_ABANDON_CAP_KIND`
    - `DB_QUERY_DEADLINE_KIND`
    - `DbAbandonCapPayloadSchema`
    - `DbQueryDeadlinePayloadSchema`
    - `dbQueryDeadlines`
    - `QUERY_DEADLINE_RING_CAPACITY`
    - `QueryDeadlineHitSchema`
- Cross-plugin:
  - Uses tokens: `ui/tokens/color-palette --muted-foreground`

<!-- AUTOGENERATED:END -->
