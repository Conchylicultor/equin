# jobs

## Portable jobs, the host's queue: `JobQueue`

`defineJob`, the registry, `job.enqueue`, the durable step / wait logs,
`jobs.resume`, `NonRetryableError` and the hold table are portable `server/` +
`core/` code. WHERE a row goes and WHO dispatches it is the **`JobQueue` host
service** (`server/internal/queue.ts`): `enqueue(job, payload, { tx?, runAt?,
jobKey?, maxAttempts? })`, `cancelUnstarted`, the Debug → Queue reads (`list`,
`retry`, `cancel`, `onActivity` — the `jobs-list` value and the `/api/jobs`
routes stay portable over them) and the lifecycle `install` / `start` /
`schedule` / `refreshSchedules` / `stop`, which THIS plugin's own phase hooks
call, so every dependent observes them exactly where it always has.

- **Desktop: `jobs#machine`** — graphile-worker: everything below (the runner
  ladder, the advisory job lock, cron, the sweeper, dead-job GC, the slot ledger,
  run stats, introspection) lives in `machine/internal/`, and its diagnostics are
  the `jobs/machine` barrel (read by `queue-health`, `background-arm` and the
  `events-test` harnesses from their own `machine/` halves). The ONE row
  insertion is `machine/internal/graphile-queue.ts`; routing (task, priority,
  queue name) is `graphile-routing.ts`. `queue-schema.ts` / `superseded-trigger.ts`
  stay in `server/internal/` (debt) only because other plugins' DB test suites
  install the schema on throwaway databases through `server/testing`.
- **No graphile: `plugins/in-process`** — an in-memory queue over the portable
  row runner `UNSAFE_runJobRow` (schema-drift check, durable ctx, suspension,
  failure classification) and the portable crontab reading in `core/cron.ts`.

## Every job says what it does: `description`

`defineJob` (and `defineSupervisedJob`, which forwards it) requires
`description`: one present-tense sentence a user reads, saying what the job does
and why — "Downloads the IP-to-country database used to place visitors on the
analytics map.", not the code name and not the mechanism. The app runs these on
its own, so this sentence is how a person learns one exists. It is stored on the
`RegisteredJob` and written to the registration's `_doc.detail`, so the generated
plugin docs list it. Trigger, schedule and scope are derived from the rest of the
spec — never restate them. `defineRetention` derives its own sentence from the
table and TTL; `defineWarmup` and `defineCorpusIndex` require one too. An empty
string is refused at define time.

## Liveness: shared fate, not a lease

**"Is this job's worker alive" is answered by Postgres, never by a clock.** For a
handler's whole lifetime `withJobLock` (`machine/internal/job-lock.ts`) holds a
session-scoped advisory lock on the graphile job id, on a **direct**-PG connection
(5433 — pgbouncer's tx pooling would not preserve the session). Postgres releases
it during backend teardown, so it vanishes the instant the owner dies (SIGKILL,
OOM, panic, `process.exit()`). The sweeper reclaims a locked row **only** when
that lock is absent from `pg_locks`. We can do this because we have shared fate
with the queue — one instance, one local PG; a general job library cannot, which
is the only reason leases exist elsewhere.

**Never reintroduce a duration-based threshold, and never infer liveness from how
long `locked_at` has been set.** A timeout cannot tell "dead" from "slow" or "host
was asleep". The previous 5-minute lease cleared `locked_at` on live rows, so
graphile re-dispatched jobs **while the handler was still running** — ~25 jobs
stolen in 8 days (nightly backups, DB forks, `./singularity push`), worst at 69
min; for non-idempotent handlers that is corruption, not wasted CPU. Its keepalive
renewed `WHERE locked_by = 'undefined'` and never matched a row — silent for three
months. A 6-hour handler is exactly as alive as a 200 ms one. Details:
[`research/2026-07-30-jobs-exact-liveness-advisory-locks.md`](../../../../research/2026-07-30-jobs-exact-liveness-advisory-locks.md).

**The sweeper's `LOCK_ACQUIRE_GRACE` (30s) is not a lease.** Graphile stamps
`locked_at` in `get_job`; we take the lock a few ms later in `dispatch()`, and a
row inside that gap would look abandoned. The grace bounds **acquisition latency**
— a constant of the dispatch path — and never grows with handler duration. Wanting
to raise it because a job is "slow" is reaching for a lease again; the answer is
no. Every reclaim is loud (`console.warn` + report); silent reclaims are what hid
the original bug.

Reading it:

- `queryRunningJobs()` and the `jobs-list` value expose `alive` per locked row
  (Debug → Queue shows a **no worker** badge). `false` = owner died, or dispatch is
  inside the sub-second acquisition window — never "has been running a while".
- The `pg_locks` key encoding lives once, as `jobLockHeldExpr` in
  `introspection.ts` (which owns the graphile coupling). Compose it, don't re-type
  it: the single-bigint form splits the key across `classid`/`objid` with
  `objsubid = 1`, and a copy that drops the `datname` guard reads a sibling
  worktree's locks.
- `deadJobPredicate` / `readyPredicate` test `locked_at IS NULL` — presence, not
  age. Unaffected; keep it that way.

`POST /api/events-test/crash-recovery` is the regression test and asserts both
halves through the public introspection API: **no-steal** (a row locked 2 min whose
lock is held by a *live* connection survives a forced sweep — the case the old
harness could not express) and **reclaim** (destroy the socket, wait for the lock
to drop, sweep, handler re-runs).

Four more harnesses beside it, same plugin, same verdict shape:

- `POST /api/events-test/queue-lock-no-steal` — the queue-level twin, guarding the
  riskier half of the same sweep: **no-steal** (a queue whose job's advisory lock
  is live survives a forced sweep and no second job in it is fetched — clearing it
  would put two jobs in a lane that exists to hold one) and **reclaim**.
- `POST /api/events-test/serial-queue` — four jobs in one `serial` lane, the first
  held open. Asserts they share one non-null `job_queue_id`, at most one is locked,
  and the other three have `locked_at IS NULL` — never fetched, holding no slot.
- `POST /api/events-test/cron-dedup` — cron-shaped inserts collapse onto one
  pending row with an unmoved `run_at`; a manual `enqueue()` shares that row.
  Drives `add_job` with the cron path's arguments rather than waiting on real
  ticks, so the key format is restated there rather than read from
  `buildCronItems`.
- `POST /api/events-test/superseded` — replays the 2026-09-12 incident: a keyed
  row held by a live stand-in worker is superseded by a re-queue of its key,
  survives a forced sweep while its lock is live (**no-steal**), is **deleted**
  (not released) once the holder dies, never shows up as a dead job, and the
  newer row runs to completion. See "Superseded rows" below.

## Run identity: a run is a queue row

A job row has two identities (`server/internal/run-identity.ts`):

- **Queue key** (graphile `job_key`) — which enqueues collapse onto one pending
  row. `singletonJobKey(name)` for `dedup: "singleton"`, shared by `enqueue()`
  and the cron item; `${name}:${key}` for a keyed dedup; none for `"none"`.
- **Run id** (`ctx.workflowRunId`) — the key of the step/wait logs a durable
  workflow replays. `workflowRunIdFor(payload, jobId)` is the one derivation:
  - **keyed dedup** bakes `${name}:${key}` — one run per key, so a second
    enqueue coalesces into the same (even suspended) workflow;
  - **everything else** — singleton, none, cron ticks — is `${name}:job:${jobId}`.
    The row id survives retries, sweeper reclaims, and an enqueue or tick
    collapsing onto the pending row;
  - **resume rows** carry the suspended run's id explicitly.

So **"singleton" means at most one PENDING row, not at most one live
workflow**: an enqueue while a singleton workflow is suspended starts a new run.
A dead run's log can no longer be replayed by the next run of the job. Dead-job
GC and the sweeper's superseded DELETE discard the logs of the rows they remove
— only row-owned run ids, since a baked (keyed/resume) id is shared with
whatever row holds that key next.

## Superseded rows

**A row graphile retires while it is locked is superseded, not dead.** Queue a
keyed job while its row is running and graphile's `add_jobs`
(`sql/000018.sql:103-116`; `remove_job` likewise) inserts a fresh row and
retires the running one: `key = null, attempts = max_attempts`. The newer row
owns the work. Once unlocked (restart sweep, graceful-shutdown timeout, failing
overrun) the old row has exactly a dead job's columns.

- **It must be a trigger.** The retire UPDATE touches only `key`, `attempts`,
  `updated_at`, so the evidence exists only inside it. `BEFORE UPDATE OF key`
  with `WHEN (OLD.locked_at IS NOT NULL AND OLD.key IS NOT NULL AND NEW.key IS
  NULL)` adds `SUPERSEDED_FLAG` to graphile's own `flags` column
  (`superseded-trigger.ts`; we configure no `forbiddenFlags`).
- **Never use "key is null" alone.** graphile retires *every* unavailable row
  with the key, dead ones included — the next cron tick would hide a real
  dead-letter. Only a retirement while **locked** is flagged.
- **Compose `supersededExpr`** (`introspection.ts`, the one spelling of the
  flag). `deadJobPredicate` excludes it; `jobs-list` hides unlocked ones.
- **The stuck-lock sweeper deletes it** once its run is over — never releases
  it. Worker died: reported like a reclaim. Already unlocked: one `jobs` log
  line, no report (`dispatch()` reported any real failure).
- `installQueueSchema` installs it after graphile's migrations. A signature in
  the trigger's COMMENT makes every later boot a catalog read with no table lock.

## Retry policy & non-retryable failures

A failing job is retried up to `maxAttempts` (default `DEFAULT_MAX_ATTEMPTS`,
overridable per-job via `defineJob({ maxAttempts })` or per-enqueue via
`enqueue(input, { maxAttempts })`), then permanently-failed: graphile leaves the
row in `graphile_worker._private_jobs` with `attempts >= max_attempts`, which the
dead-job GC archives into `dead_jobs` and queue-health surfaces as a dead-letter.

Retries only earn their keep when the failure is **transient** (DB hiccup,
network blip, lock contention) — a later attempt might succeed. When a failure is
**deterministic** (the same stored input will fail identically every time —
schema/contract drift, a permanently-invalid payload), retrying is pure waste,
and for a frequently-re-enqueued job it churns the queue ×`maxAttempts`.

For that case, throw a **`NonRetryableError`** (exported from the server barrel)
from the job's `run`. The worker collapses the row's retry budget so graphile
dead-letters it after the **single** current attempt instead of burning the full
budget — while keeping the failure loud and visible (it is still reported and
still lands as a dead-letter). Use it ONLY for failures that cannot succeed on
replay; a plain `Error` remains the right choice for anything retry could fix.

## Hold class: what bounds this handler

`defineJob({ hold })` is required, and answers exactly one question: **how long
may ONE RUN of this handler hold a worker slot?** Not how long the workflow takes
— `ctx.waitFor` / `ctx.sleep` RETURN from `run` and release the slot, so a
workflow may span days while every one of its runs is `instant`.

Declare it from what **bounds** the handler, never from its observed mean. A
model call with a 30 s timeout is `seconds` however fast it usually returns.

| `hold` | the bound is | how a reviewer checks it | slots |
|---|---|---|---|
| `instant` | no blocking I/O — indexed reads/writes, in-memory work | no network, no spawn, no model call | **8** |
| `seconds` | a timeout the handler passes itself (`timeoutMs`, `HAIKU_TIMEOUT_MS`) | `grep timeoutMs` in the handler | **6** |
| `minutes` | nothing shorter than the work — subprocess, `pg_dump`, Chromium, archive upload, an open-ended step machine | does it spawn, render, or upload? | **4** |

The boundary is chosen to be checkable and stable, not numerically optimal: with
utilization this low, every cutoff across two orders of magnitude buys the same
milliseconds. What matters is that the partition exists at all. Queueing delay
scales with the *second moment* of service time, not its mean — measured over 41
minutes on main, `E[S] = 978 ms` while `√E[S²] = 19,168 ms`, so one heavy job
type set the wait for everything behind it. `queue-wedged` exists because four
long handlers took all four slots and everything behind them stopped, observed at
40+ minutes.

There is one declaration and no second field: `hold` picks both the reservation
tier and the deadline that aborts `ctx.signal`. A lane and a budget cannot
disagree if there is only one thing to declare.

### `minutes` must say why it runs in process (`inProcess`)

`hold: "minutes"` does not compile without `inProcess: string` (and `instant` /
`seconds` cannot declare it; an empty reason throws at define time). A `minutes`
handler runs inside the backend, so any deploy or restart kills it mid-run and
it re-runs from scratch — while holding one of the four long-work slots for its
whole duration. The reason is one honest sentence saying why that is acceptable
(e.g. "both steps are idempotent; a rerun no-ops what landed").

If it is not acceptable — long work that must survive a restart, or must not
hold a worker slot — use `defineSupervisedJob`
(`plugins/supervised-job`), which runs the body as a detached child the backend
re-attaches to. The stale-worktree reaper and the database fork were written as
plain `minutes` jobs by default and died mid-run on deploys; this field makes
that a stated choice rather than the path of least resistance.

### The deadline is a SIBLING of the ceiling, not the same number

| `hold` | `ceilingMs` (work) | slot-hog report | `deadlineMs` (hold) | zombie |
|---|---|---|---|---|
| `instant` | 10 s | 30 s | 60 s | 90 s |
| `seconds` | 2 min | 5 min | 10 min | 10 min 30 s |
| `minutes` | 30 min | 30 min | 60 min | 60 min 30 s |

An earlier version of this section promised the ceiling would *become* the
deadline. It must not. **`ceilingMs` bounds WORK (`durationMs − waitMs`); a
deadline can only ever be measured on wall-clock HOLD**, because at the instant
the timer fires nothing yet knows how the elapsed time split. Those quantities
genuinely differ — that is what `queue-slot-blocked` exists to report — so
aborting on hold at the work ceiling would kill conforming handlers for waiting
on an admission gate entered after dispatch. The gap between the two numbers is
the statement of how much gate wait we are willing to believe.

`queue-slot-hog` reports at a fraction of the deadline (strictly below 1), so
warn-before-kill holds for every class at every settable config value.

### What the deadline does, instant by instant

- **at `deadlineMs`** — `ctx.signal` aborts with a `JobDeadlineExceededError`,
  and a `job-deadline-exceeded` report is filed. **Nothing else.** The dispatch
  does not return, the advisory lock is not released, the row is not touched.
- **shortly after** — a handler that threaded the signal into what it awaited
  unwinds. Ordinary job failure from here: lock released, slot freed, reported,
  retried. A run aborted on attempt ≥ 2 dead-letters instead of burning
  `maxAttempts × deadline` of slot time.
- **+30 s, still unsettled** — `job-zombie`. The slot is **forfeited**: written
  off for the life of this process. The row is still untouched, and its lock is
  still held by this live backend, so the sweeper provably will not reclaim it.

### Forfeit is accounting, not recovery

**Forfeiting a slot touches no row, releases no lock, and stops no handler.** It
records one fact — this slot is gone until the process ends — so that
`usableSlots(runner)` can be counted, the floor below can be checked, and Debug
→ Queue can stop calling a written-off run *running* (it shows a `forfeited`
badge beside `no worker`; the two are opposites — `no worker` means nobody is
there, `forfeited` means somebody is and we stopped waiting).

**This paragraph is the one that stops someone "fixing" forfeit into a
reclaim.** The zombie still holds its advisory lock, and that is not an
oversight — it is the whole mechanism. The lock is what tells the stuck-lock
sweeper the row still has an owner. Release it (or clear `locked_at`) and the
sweeper reclaims a row whose handler is still running, graphile re-dispatches
it, and a possibly non-idempotent handler runs twice: exactly the corruption the
age-based lease caused, ~25 stolen live jobs in 8 days. A running promise cannot
be un-awaited. The abort was the only lever, and forfeit is what we do when it
did not work.

`disarm()` clears the entry, so a zombie that eventually settles un-forfeits
itself and its slot comes back — the only way short of a restart that it does.

### The floor, the crash and the latch

Written-off slots accumulate, and at some point the pool can no longer do the
work only it can do. That point is: **the runner serving the longest hold class
has fewer than 2 usable slots.**

Both halves are derived from the class table, never spelled — the runner is
`RUNNERS`' single entry whose `serves` includes the last of `HOLD_CLASSES`
(`forfeit.ts` throws at module eval if the ladder ever grows a second one,
because the condition would then have to be about their combined capacity).

Why *that* runner and why *2*: it is the only one that can serve `minutes`, so
DB forks, conversation spawns, builds and backups have nowhere else to go — a
shorter class inherits a longer class's idle slots, never the reverse. One
usable slot means the next long job to arrive consumes that class's entire
capacity. The old "one slot lets a long job block every monitor" argument no
longer needs making separately: monitors are `instant`, and the narrowest runner
already reserves slots only they can reach.

On the trip, the backend writes its report **synchronously to disk** and calls
`process.exit(1)`. Exiting is the point: Postgres drops every advisory lock
during backend teardown, so the next boot's sweeper reclaims those rows — this
time provably, their owner no longer exists — and the work re-runs.

- **A narrower runner going fully forfeited is a report, not a crash.** Its work
  still reaches the wider runners (the task lists are nested), so the pool is
  degraded, not dead.
- **Three floor exits within an hour suppress the fourth** — report, and stay
  up. An automatic restart that fixes nothing is worse than an honest wedge. The
  latch survives the exit as one small JSON file under `jobs/data-dirs`. Read
  that file's comment before pattern-matching its timestamps onto the banned
  lease: it governs **our own restart policy** and makes no claim about whether
  any worker is alive.
- **The respawn is lazy, not automatic.** The gateway does not restart an exited
  backend (`gateway/worktree.go`'s `onBackendExit` just marks the worktree
  idle); the next proxied request spawns a fresh one. So a worktree nobody is
  looking at stays down until someone looks — acceptable, since its widest
  runner was dead, but the floor crash is not a self-healing restart.

The report is one kind, `job-slot-floor`, with a discriminated
`action: "crashed" | "degraded"` — one condition, two honest arms. It reaches
the next boot through `reportServerFatalSync`, the synchronous twin of
`reportServerError`: `recordReport` is a Postgres write and the caller's next
statement is the exit, so it takes the same durable path a crash does (one
appended JSONL line, replayed on the next boot) and adds only that the line
names its own kind.

**There is no `Promise.race`, and there must never be one.** Racing would let the
wrapper return while the handler still runs — releasing the lock, letting the
sweeper reclaim the row, letting graphile re-dispatch a possibly non-idempotent
handler alongside its own zombie. The timer aborts a signal; the slot frees only
when the handler actually settles.

**This is not the liveness inference banned at the top of this file.** That claim
is third-person — "this row has been locked T, so its owner is dead, so I may
re-dispatch it". A deadline is first-person: *I* have been running this handler
for T and *I* am giving up on it. The process making the claim holds the lock, so
it cannot steal from itself, and it moves no row.

`jobs/plugins/deadline-audit/` owns the three report kinds; `jobs` announces on a
`defineReportSink` seam rather than naming `reports` (which already imports
`jobs`).

### The reservation is at FETCH, never after dispatch

`RUNNERS` (`core/hold.ts`) is three graphile runners over nested task lists —
`floor` serves `instant` only, `mid` adds `seconds`, `wide` adds `minutes` plus
the legacy task. graphile's fetch query partitions on `task_id = any($2::int[])`,
so **a runner physically cannot see a task identifier absent from its own
`taskList`**. Two of the eight slots are unreachable by anything that can run for
minutes, and the heavy ceiling stays at 4 — exactly what the single pool allowed.

That placement is the whole design, and it is the lesson `serial` already
encodes above: an in-process gate entered **after** graphile hands over a job
turns one stuck job into N stuck slots. A "lane" implemented as a semaphore
inside `dispatch()` would reproduce that bug wholesale. Nesting rather than
disjoint queues means a shorter class always inherits a longer class's idle
slots, so the only capacity ever stranded is the floor's two.

`priority` (lower wins) then decides preference *inside* a runner, so a class's
own tier fills before it spills into a narrower one. Priority alone could never
have fixed this — it reorders *pick* time, never *hold* time.

### Conformance is measured on WORK, not on hold

A job's slot-hold is substantially **not a property of the job**. `jobs.dead-gc`
was measured holding a worker slot for **77 seconds while doing 254 ms of work**;
the remainder was blocked on `background-tx-acquire`, an admission gate entered
*after* graphile had already handed it a slot. `debug.session-divergence-monitor`:
25.6 s hold, 4.2 s work. `mail.sync-tick`: 85% wait.

So the class ceiling is applied to **work time = `durationMs − waitMs`**
(`debug/slow-ops`, `resolve-threshold.ts`), and only for the `job` span kind —
every other kind is still judged on wall-clock. Comparing hold would file a
slot-hog report against a correctly-classified `instant` job every time the DB
background lane got busy, punishing it for someone else's congestion and training
every author to inflate their class until the signal is worthless. Do not "fix"
this back to `durationMs`.

The worked example is `page.attachment-block.reconcile`: a 1050 s `max_ms` in
`slow_ops` argued for `minutes`, but the handler is one indexed `SELECT` and an
indexed `set()` per block — no network, no spawn, no model call, so `instant`.
The tail was gate wait plus an unbatched loop. If its *work* ever does pass 10 s,
the report names the real defect instead of blessing it with a bigger class.

Hold ≫ work is its own signal, and `debug/queue-health` reports it separately:
"held a slot 77 s to do 254 ms of work, blocked on `background-tx-acquire`" names
a real bug where "slow job" does not.

### Reclassifying later is safe by construction

`repointHoldTasks()` runs on every boot, before the runners start, and is written
as a standing invariant rather than a migration: **a pending row sits on the task
and priority its `jobName`'s current class declares**. Change a job's `hold` and
its already-queued rows move on the next boot. Locked rows are left alone — they
finish where they are, and a retry lands re-pointed.

The legacy `jobs.run` task stays registered on the wide runner forever, so a row
written by an older backend or mid-deploy can never strand on a task no runner
serves. It reads as `minutes`, the most conservative tier.

### Nothing checks that a class is honest — deliberately

The enforcement ladder here stops at rung 2 and resumes at rung 4. `hold` is
required, so a partial migration is not expressible (tsc); a job whose *work*
exceeds its class ceiling files a report naming itself, every tick, until it is
reclassified or fixed (loud runtime), and a run that overruns the class's
*deadline* is aborted outright.

Rung 3 is empty on purpose. An earlier draft proposed a reviewed membership file
listing which jobs may claim which class. Against a duration axis that file is a
static restatement of a *runtime* fact, editable by every plugin that adds a job
and verifiable by nobody. The truth is measured, so it is enforced where it is
observable.

What IS checkable is the wiring, and that is checked: `jobs:no-raw-addjob`
confines both the row insertion and the bare `"jobs.run"` task literal to one
file each, because a hand-typed identifier is a row that silently lands in the
widest tier and escapes its reservation with no type error and no symptom.

Design, measurements, prior art and the risks to watch:
[`research/2026-08-19-global-job-hold-class-reserved-slots.md`](../../../../research/2026-08-19-global-job-hold-class-reserved-slots.md).

## Slot ledger: which tier holds which job

**The ledger (`machine/internal/slot-ledger.ts`) is the only exact answer to
"which runner's slot is this job in".** The database cannot say: the three
runners share one job table, and a locked row records only graphile's random
worker id. But we create the runners, so `startWorkers` gives each its own event
emitter, attached **before** `run()` (a runner can start jobs inside `run()`).
An event heard there comes from that runner's slots.

- `job:start` adds an `OccupiedSlot`, keyed by `worker.workerId` (one worker is
  one slot). Its `hold` is the class of the task the row was fetched on, the
  same reading `queryRunningJobs` and `queue-slot-hog` use.
- `job:complete` and `worker:fatalError` remove it. **These are graphile's
  events, not a `finally` around `dispatch()`**: `job:complete` fires after
  graphile has written the outcome back, so the ledger never shows a slot free
  while its row is still locked. A `finally` in our handler would run before that
  write.
- `stopWorkers` clears it, because a graceful shutdown that times out releases
  jobs with no `job:complete`.

A ledger listener must never throw into graphile. From `job:start` that would
leave a worker holding a job it never runs. From `job:complete` it would take the
worker down. So listener errors are reported and the loop goes on.

**Pickup time.** Each `job:start` also records `locked_at − run_at`, both
database timestamps, into a per-class ring (15 min, at most 1024 per class).
Rows in a `serial` lane are not sampled, since they may have waited for their
lane rather than for a slot. `getPickupStats()` returns nearest-rank p50 / p95 /
max. A class with no samples reads `count: 0` with `null` percentiles, never
`0 ms`. Compare against `pickupTargetMsFor(hold)` in `core/hold.ts`.

**One activity signal.** `onQueueActivity(listener)` fires on every ledger
event, on `jobs:insert` (heard on the legacy runner only, because each runner
has its own LISTEN client), and on this plugin's own mutations that send no
notification: retry, cancel, `abortDurableRun`, the resume timeout delete, the
stuck-lock reclaim and dead-job GC. `jobs-list` reloads on it, throttled to one
reload per second, instead of polling: `jobsList` (`core/resources.ts`) is a
`liveValue` declared `load: "on-demand"` (a 500-row join read by one Debug pane,
kept out of the shared flush — tabs refetch over HTTP on each invalidate), and
`jobsListServed` serves it external with `throttleMs: 1000` and
`whileSubscribed: (_p, notify) => onQueueActivity(notify)`, so it listens only
while a tab is subscribed. **A new raw write to graphile's tables
must call `emitQueueActivity()`**, or every queue reader goes stale until the
next unrelated event.

The database side of the same picture is `queryQueuePulse()`,
`queryOldestWaiting()` and `queryRecentDeadJobs()` in `introspection.ts`. There,
"waiting for a slot" excludes rows queued behind a held serial lane
(`waitingForSlotPredicate`), because a lane waits by design. A row locked in the
database but absent from the ledger is held by a dead worker. The stuck-lock
sweeper will reclaim it.

**The dead-letter archive is a live collection.** `deadJobs`
(`core/resources.ts`, key `dead-jobs`) is a `liveCollection` over
`dead_jobs` backing a live DataView (key-range pages): newest archived first, 200 rows by
default, grown up to `DEAD_JOBS_ARCHIVE_CAP` (2000) — the same constant the
dead-job GC trims the archive to, so a fully grown window is the whole archive.
It filters on `jobName` / `lastError` (search, and `jobName` as a facet),
`attempts`, `diedAt` and `archivedAt`. `deadJobsServed` serves it with
`serveCollection(deadJobs, { from: _deadJobs })`, every row field bound to its
column by name (the two timestamps are `Date`s). `dead_jobs` is a public table,
so the change feed moves every subscribed window on the GC's archive and purge;
nothing notifies it. `GET /api/jobs/dead` serves the same rows wrapped as
`{ rows }` (`DeadJobsPayloadSchema`).

**The run history is a live collection too.** `run-stats.ts` records every
finished run (graphile's `job:complete`) into `job_run_stats` (one row per job:
latest run + counters) and `job_runs`, a ring of the last `RECENT_RUNS_RING`
(20) runs per job name — so `job_runs` is bounded by 20 × job names. A run's
row carries what the queue row said about it (graphile's `jobId`, the task's
`hold`, `maxAttempts`, `queuedAt` = `run_at`, and the payload's `input`) and its
error message up to `RUN_ERROR_CHARS` (8000; the stats row keeps a 500-char
preview). Its `id` is `<jobName>:<seq>`, a stored generated column and the
table's single-column primary key — `job_recent_runs`, its predecessor, had a
composite (job_name, slot) key no collection can bind; its rows were copied
over by the migration that dropped it. The ring's upsert targets the unique
(job_name, slot) index, so overwriting a slot moves the row's id, and the change
feed names both ids. `jobRuns` (key `job-runs.all`) is an `all` collection
over it — the whole ring, newest finished first (`unbounded`: a ring of 20 per
job name), plus its `:rows` sibling. Its reader, Debug → Queue's Jobs list,
merges it with the live graphile queue and filters, sorts and groups the merge
on the client, so it holds every run. `waitMs` (`startedAt − queuedAt`, floored
at 0, NULL without a `queuedAt`) is an `expr` column computed in SQL. Nothing
prunes a retired job name's ring yet.
`readRecentJobRuns(name)` still reads one job's ring for the Background
activity catalog.

## Connections: every one carries the deadline

The plugin owns four connection sets, all on the DIRECT socket
(`connectionString()`), and all built by the connection plugin's
`createDbPool` (`plugins/database/plugins/connection/CLAUDE.md`). So opening a
connection and every statement on it gives up after 60 s with no reply, and the
`QueryDeadlineExceededError` names the pool:

| pool | built in | what runs on it |
| --- | --- | --- |
| `jobs-runner` | `worker.ts` `getRunnerPool` | the three runners' fetches, completions and LISTEN connections (shared, `TOTAL_JOB_SLOTS + RUNNERS.length`) |
| `jobs-enqueue` | `worker.ts` `getEnqueuePool` | `WorkerUtils` — `addJob`, reschedule, complete (max 10, graphile's old default) |
| `jobs-schema` | `queue-schema.ts` `installQueueSchema` | graphile's migrations + the superseded trigger, under `BOOT_DDL_QUERY_DEADLINE_MS` (15 min) |
| `job-lock` | `job-lock.ts` `lockPool` | the advisory lock / unlock around each handler |

- **Both worker pools are handed to graphile as `pgPool`.** graphile ends only a
  pool it built itself, so `stopWorkers()` ends both: the enqueue pool after
  `utils.release()`.
- **A failed `makeWorkerUtils` is not cached.** Its migration check can now fail
  on a missed deadline; the next enqueue builds again instead of every enqueue
  failing until restart.
- **A job's lock is never bounded by the deadline.** The handler runs on other
  connections while the lock connection sits idle with nothing pending. Only the
  two short lock statements are. If one of those gets no reply, its connection
  is abandoned, not destroyed (`release(true)` is a no-op on it), so a lock
  Postgres did grant stays held until this backend exits. That fails safe: a
  re-dispatch reads `LOCK_HELD`, never a double run.
- **A silent LISTEN socket is not covered.** A runner's LISTEN connection with no
  call pending has nothing waiting for a reply; that needs a heartbeat.

`enqueue-deadline.test.ts` proves the enqueue path: graphile's `addJob` through a
`jobs-enqueue` pool behind a black-hole proxy rejects naming that pool.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Durable background jobs primitive: plugins declare jobs via defineJob and enqueue via job.enqueue, onto the host's job queue (JobQueue — graphile-worker on the desktop).
- Load-bearing: yes
- Server:
  - Contributes:
    - `resource.declare` "dead-jobs"
    - `resource.declare` "dead-jobs:groups"
    - `resource.declare` "dead-jobs:rows"
    - `resource.declare` "job-runs.all"
    - `resource.declare` "job-runs.all:rows"
    - `resource.declare` "jobs-list"
    - `host-service:jobs.queue` "jobs.queue"
    - `fork-schema-data-exclusion` "graphile_worker"
  - Uses:
    - `database.db`
    - `database/connection.BOOT_DDL_QUERY_DEADLINE_MS`
    - `database/connection.createDbPool`
    - `database/connection.withQueryDeadline`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `database/sql-projection.parsed`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `network/live.serveCollection`
    - `network/live.serveValue`
  - DB schema:
    - `plugins/infra/plugins/jobs/server/internal/queue-schema.ts`
    - `plugins/infra/plugins/jobs/server/internal/tables.ts`
  - Exports (types):
    - `DefineJobSpec`
    - `DurableHooks`
    - `EnqueueOpts`
    - `EnqueueTx`
    - `HoldClass`
    - `HoldClassSpec`
    - `JobCtx`
    - `JobDeadlineEvent`
    - `JobFactory`
    - `JobQueueImpl`
    - `JobRowOpts`
    - `JobRowOutcome`
    - `JobSlotFloorReport`
    - `JobTaskPayload`
    - `QueuedJob`
    - `RegisteredJob`
    - `RunnerSpec`
    - `ScheduleSpec`
    - `SerialSpec`
  - Exports (values):
    - `_deadJobs`
    - `_jobRuns`
    - `_jobRunStats`
    - `abortDurableRun`
    - `ALL_JOB_TASKS`
    - `ceilingMsFor`
    - `deadlineMsFor`
    - `DEFAULT_MAX_ATTEMPTS`
    - `defineJob`
    - `getAllRegisteredJobNames`
    - `getJobHold`
    - `getJobSlowThresholdMs`
    - `HOLD_CLASSES`
    - `HOLD_SPECS`
    - `HoldClassSchema`
    - `holdForTask`
    - `isJobDeadlineExceededError`
    - `isNonRetryableError`
    - `isSuspendSignal`
    - `JOB_SLOT_FLOOR_KIND`
    - `JobDeadlineExceededError`
    - `jobDeadlineSink`
    - `JobQueue`
    - `LEGACY_JOB_TASK`
    - `listRegisteredJobs`
    - `NonRetryableError`
    - `pickupTargetMsFor`
    - `priorityFor`
    - `reachableSlots`
    - `refreshJobSchedules`
    - `resolveJobCron`
    - `RUNNERS`
    - `singletonJobKey`
    - `taskFor`
    - `TOTAL_JOB_SLOTS`
    - `UNSAFE_getRegisteredJob`
    - `UNSAFE_installDurableHooks`
    - `UNSAFE_runJobRow`
  - Register: `defineJob('jobs.resume')`
  - Resources:
    - `dead-jobs` (keyed, window)
    - `dead-jobs:groups` (push)
    - `dead-jobs:rows` (keyed, point)
    - `job-runs.all` (keyed)
    - `job-runs.all:rows` (keyed, point)
    - `jobs-list` (invalidate, notified)
  - Routes:
    - `GET /api/jobs`
    - `GET /api/jobs/dead`
    - `POST /api/jobs/:id/retry`
    - `DELETE /api/jobs/:id`
- Core:
  - Uses:
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/float/config.floatField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.parsedTextField`
    - `fields/text/config.textField`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `network/live.liveValue`
  - Exports (types):
    - `Crontab`
    - `DeadJobListRow`
    - `DeadJobRow`
    - `DeadJobsPayload`
    - `HoldClass`
    - `HoldClassSpec`
    - `JobRow`
    - `JobRunOutcome`
    - `JobRunRow`
    - `JobsPayload`
    - `JobState`
    - `RunnerSpec`
  - Exports (values):
    - `ALL_JOB_TASKS`
    - `cancelJob`
    - `DeadJobRowSchema`
    - `deadJobs`
    - `DeadJobsPayloadSchema`
    - `deadlineMsFor`
    - `HOLD_CLASSES`
    - `HOLD_SPECS`
    - `HoldClassSchema`
    - `holdForTask`
    - `JobRowSchema`
    - `JobRunOutcomeSchema`
    - `jobRuns`
    - `jobsList`
    - `JobsPayloadSchema`
    - `JobStateSchema`
    - `LEGACY_JOB_TASK`
    - `listDeadJobs`
    - `listJobs`
    - `nextCronFiring`
    - `parseCrontab`
    - `pickupTargetMsFor`
    - `priorityFor`
    - `reachableSlots`
    - `retryJob`
    - `RUNNERS`
    - `taskFor`
    - `TOTAL_JOB_SLOTS`
- Cross-plugin:
  - Imported by: 69 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×19
    - `conversations` ×13
    - `infra` ×13
    - `debug` ×8
    - `tasks` ×4
    - `database` ×3
    - `page` ×3
    - `build`
    - `improve`
    - `integrations/youtube/audio-fetch`
    - `shell/notifications`
    - `stats/cost`
    - `upstream`
- Exemptions:
  - Exempts itself from:
    - `timer/no-unlisted-timer` — `machine/internal/stuck-lock-sweeper.ts` (sanctioned)
    - `jobs:no-raw-addjob` — `machine/internal/graphile-queue.ts`, `check/index.ts` (sanctioned)
    - `jobs:no-raw-addjob` — `machine/internal/enqueue-deadline.test.ts` (sanctioned)
    - `jobs:no-raw-addjob:task-literal` — `core/hold.ts`, `check/index.ts` (sanctioned)
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `boundaries/no-platform-api` — `server/internal/queue-schema.ts`, `server/internal/superseded-trigger.ts` (debt)
- Machine:
  - Exports (types):
    - `BacklogJobStat`
    - `CronRanges`
    - `DeadJobGroupStat`
    - `DeadJobStat`
    - `ForfeitedSlot`
    - `JobRunOutcome`
    - `JobRunRecord`
    - `JobRunStats`
    - `OccupiedSlot`
    - `PickupStats`
    - `QueueBacklogStat`
    - `QueueClassBacklogStat`
    - `QueueClassPulse`
    - `RunningJobStat`
    - `WaitingJobStat`
  - Exports (values):
    - `cronRanges`
    - `DEAD_ERROR_PREVIEW_CHARS`
    - `getForfeitedSlots`
    - `getOccupiedSlots`
    - `getPickupStats`
    - `nextScheduledRun`
    - `onJobRunsChanged`
    - `onJobSchedulesChanged`
    - `onQueueActivity`
    - `PICKUP_WINDOW_MS`
    - `queryBacklogByJobName`
    - `queryDeadJobStats`
    - `queryOldestWaiting`
    - `queryQueueBacklog`
    - `queryQueuePulse`
    - `queryRecentDeadJobs`
    - `queryRunningJobs`
    - `readJobRunStats`
    - `readRecentJobRuns`
    - `runningJobStarts`
    - `UNSAFE_sweepStuckLocks`
  - Register:
    - `defineJob('jobs.dead-gc')`
    - `defineTimer('jobs.stuck-lock-sweep')`
- Test helpers:
  - Server: `@plugins/infra/plugins/jobs/server/testing`
    - `installQueueSchema` — Install (or bring up to date) graphile-worker's own schema on the database `connectionString` names, plus this plugin's superseded-row trigger on graphile's job table.
- Sub-plugins:
  - **`background-arm`** — Jobs in the Background activity catalog: registers the `job` background kind — every registered job with its trigger (a schedule in words and its next firing, read from graphile's own parse and…
  - **`deadline-audit`** — Job deadline audit: registers a handler on the jobs plugin's deadline seam and turns each announcement into a report — job-deadline-exceeded (warning) when a run passes its hold class's wall-clock…
  - **`in-process`** (excluded) — The in-process job queue: provides the JobQueue host service in memory — a row runs in this process when it is due (a transaction's enqueue only once it commits), scheduled jobs fire on a one-shot…
  - **`supervised-job`** — Out-of-process work as an ordinary job: defineSupervisedJob composes defineJob + a supervised-run kind into a handler that claims, spawns detached and SUSPENDS — so no worker slot is held while the…

<!-- AUTOGENERATED:END -->
