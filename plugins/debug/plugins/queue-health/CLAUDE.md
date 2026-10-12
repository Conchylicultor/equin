# queue-health

The graphile-worker job queue degrades **silently** — nothing in the UI signals
when it breaks. This plugin makes its saturation/failure modes **loud** by filing
them into the existing reports engine (the same surface that captures crashes),
modeled byte-for-byte on `debug/slow-ops` (durable signal → `ReportKind` →
deduped report; investigation task on demand), and surfaces an attributed snapshot on demand via a summary
endpoint + the `get_queue_health` MCP tool. It reads the queue **read-only**
through the jobs plugin's public introspection API (`queryDeadJobStats` /
`queryQueueBacklog` / `queryBacklogByJobName` / `queryRunningJobs`), which owns
the graphile-internals coupling — the per-class task identifiers, the
`payload->>'jobName'` encoding, the ready/terminally-dead predicates — so this
monitor can never drift from how the queue is actually encoded.

## The queue is a ladder, not a pool

Every job declares a `hold` class (`instant` / `seconds` / `minutes`) and three
graphile runners with NESTED task lists drain them, for `TOTAL_JOB_SLOTS` slots
in total. A class's rows can only be picked up by the runners that serve it, so
`instant` reaches 8 slots, `seconds` 6, `minutes` 4 — and the nesting is
one-way: idle `minutes` slots run `instant` work, never the reverse.

Everything about the ladder — the classes, the slot counts, the per-class work
ceilings — is read from `@plugins/infra/plugins/jobs/core`'s class table
(`HOLD_SPECS`, `RUNNERS`, `TOTAL_JOB_SLOTS`, `ceilingMsFor`, `reachableSlots`).
**No code in this plugin restates a slot count or a duration from it** — not the
detectors, not the report renderers, and not the `get_queue_health` MCP tool's
description, which interpolates the ladder rather than describing it in prose. A
number that had drifted from the runtime would be worse than no number. (The
figures in this document are prose, and prose is allowed to name them; the
runtime never reads them.)

What the data can and cannot answer:

- **Which runner holds a locked row** — not from the database, but exactly from
  memory, for this backend. The three runners share one `_private_jobs` table
  and graphile records no runner id per row, so every `lockedCount` (and every
  watchdog detector, which reads only the database) still counts locked ROWS of
  a class, never slots held by a tier. The jobs plugin's **slot ledger**
  (`getOccupiedSlots`) answers the tier question: we create each runner, each has
  its own event emitter, so a `job:start` heard on it names the runner whose
  slot took the job. The Job queue row's bars are built on it (see
  [Health row and pulse](#health-row-and-pulse)). What the ledger cannot see is a
  row locked by a worker that died — that one is in the database and not in the
  ledger, which is exactly how the pulse counts `orphanLocked`.
- **Why a slot is held** — not visible from the queue. `locked_at` gives HOLD,
  which includes time the handler spent blocked on an admission gate entered
  after graphile handed it the slot. The wait/work split lives in the runtime
  profiler; see `queue-slot-blocked` below.
- **Whether a class drained** — exact, and cheap. It is the per-class backlog
  aggregate this plugin already takes, so `queue-class-starved` is built on it.

## The monitor is an interval, not a job

`server/internal/watchdog.ts` is a raw `setInterval` (30s) on the backend's own
event loop, started from `onReady` and stopped in `onShutdown`. It used to be a
scheduled job — `debug.queue-health-monitor`, `{ cron: "*/5 * * * *",
perWorktree: true }` — and that is exactly why the 2026-08-17 incident was
found by hand. Main's queue wedged for 70 minutes with **eleven copies of this
monitor sitting in the frozen backlog it exists to report**. Both its
`queue-backlog` and `queue-slot-hog` conditions were satisfied; neither report
was ever filed, because the thing that files them was queued behind the wedge.

A monitor queued behind the failure it detects detects nothing. The doctrine was
already written down, in this repo, on the jobs plugin's `stuck-lock-sweeper.ts`:
*"Infra that recovers the job system must not depend on the job system."* This
file is the same rule applied to the alarm rather than the recovery, and it is
modeled on that sweeper byte for byte — module-level timer, `start`/`stop` pair,
`runTracked` wrapper, `.catch → console.warn`, plus an exported
`queueHealthTickOnce()` for forcing a tick.

**Cadence is a module constant (`TICK_MS = 30_000`), not config**, for the same
reason the sweeper's `SWEEP_INTERVAL_MS` is: it is a property of the detector,
not a threshold an operator tunes. 30s gives six samples per three-minute wedge
window, so one slow or skipped tick cannot false-negative. `queryDeadJobStats()`
runs only every 10th tick — a dead-letter stays dead, and that preserves the
5-minute cadence the old scheduled monitor gave it.

Known escalation, deliberately not built: the watchdog rides the same event loop
it watches, so a wedged **loop** silences it. That failure class belongs one
level lower — the sentinel's worker thread. A monitor runs exactly one level
below the subsystem it watches, and no lower.

### Why it lives here and not beside the sweeper in `jobs`

The plugin DAG forbids the other placement. `reports/server/internal/record-report.ts`
imports `recordNotification` from `shell/notifications`, whose barrel imports a
`defineJob` from `jobs` — so `jobs → reports → shell/notifications → jobs` is a
cycle, and `no cycles` is enforced by `./singularity check plugin-boundaries`.
This plugin already imports both `jobs` and `reports`, so the placement adds
**zero new plugin edges**, and it keeps queue *interpretation* (thresholds,
config, report kinds) out of the load-bearing mechanism-only `jobs` plugin.

## What it monitors

Each tick takes **one** `queryQueueBacklog()` and **one** `queryRunningJobs()`
and shares that snapshot across all four live checks — cheaper than the old
per-check queries, and load-bearing for the wedge test, which compares a
locked-id set against a locked count and would reset its own clock forever if
the two came from different snapshots. Reports fire only when a threshold trips:

- **`queue-wedged`** (variant `error`) — **the queue has stopped draining.** The
  other three say the queue is deep, or that something is slow; both are
  routinely true and benign (the nightly `backup.run` trips slot-hog every
  night). This one says the thing an operator must act on. It trips only when
  all four hold **continuously for `wedgeMinutes`** (default 3):
  1. every slot is held (`running.length >= TOTAL_JOB_SLOTS`, summed over
     every runner in the jobs ladder);
  2. the set of locked job ids is **unchanged across ticks** — the condition
     that separates "wedged" from "busy". A saturated pool that is completing
     work churns its ids every tick and never trips;
  3. `readyCount > 0` — work is actually being starved. Four long jobs with an
     empty queue behind them is a busy machine, not an outage;
  4. every holder is **`alive`** — a row whose owner *died* belongs to the
     stuck-lock sweeper, which reclaims it within a minute; reporting it here
     would double-report a condition already recovering itself.

  The only state this needs is one module-level `{ ids, since }` candidate,
  cleared the moment any condition stops holding. No new SQL — all four facts
  come from the existing introspection API. `heldForMs` is the **minimum**
  `lockedForMs` across holders (every slot has been held at least this long),
  read off graphile's `locked_at` rather than off our own observation window, so
  a backend booting into an already-wedged queue reports the true 14 minutes
  instead of the 3 it has been awake. **One rolling report per worktree**
  (fingerprint `queue-wedged`).

  It stays **global** under the ladder, deliberately: it means every slot on
  every runner is frozen, so nothing of any class can start. The payload now
  carries the per-class occupancy so an operator can see which tier the frozen
  rows belong to; the weaker per-tier claim is its own kind, below.
- **`queue-class-starved`** (variant `error`) — **one tier of the ladder has
  stopped draining**, while the pool as a whole may look perfectly healthy: rows
  churn, `lockedCount` moves, and one whole category of work has not budged. This
  is the kind that **verifies the reservation in production** rather than
  asserting it — if reserving two slots for `instant` work does what it claims,
  this never fires for `instant` — and it is the signal that would have named the
  40-minute `tasks.push-ingest` lag behind the whole design.

  Two conditions, both continuous for the class's own window:
  1. **the head did not move.** A class's oldest ready row is also the next row
     graphile will pick from it (`getJob` orders `priority asc, run_at asc`, and
     every row of a class carries that class's priority), so an unmoved head
     means nothing came off the front. The head is identified by its `run_at`,
     derived as `now - oldestOverdueMs` within a 1s drift tolerance — not by job
     id, which no introspection query exposes for ready rows;
  2. **the ready depth did not fall** below where the candidate opened. This is
     what keeps a fan-out burst honest: `emit()` writes N rows with nearly
     identical `run_at`, so a *draining* burst still looks like a frozen head
     inside the tolerance — but its depth falls every tick, which resets the
     candidate.

  **Known residual**, stated rather than papered over: a row can be ready and
  still unpickable — graphile's fetch skips a row whose `serial` queue name is
  locked by a running sibling. If such a row sits at the head while the rest of
  the class drains AND arrivals hold the depth at or above the candidate's
  opening value, this fires: a real stall of that class's head, caused by one
  blocked lane rather than by the ladder. Ruling it out would need a per-class
  COMPLETION counter, which nothing exposes today (the runtime profiler counts
  completions per jobName, not per class). The report names the jobs at the head,
  which is enough to tell the two apart by eye.

  The window is the **longer** of `wedgeMinutes` and the class's own work
  ceiling. A flat three minutes would be nonsense for `minutes`, whose conforming
  runs may hold every reachable slot for half an hour; three minutes of a frozen
  `instant` head, ceiling ten seconds, is already damning. Per-class candidates
  in a `Map`, cleared the same way the wedge candidate is. **One rolling report
  per (class, worktree)** (fingerprint `queue-class-starved:<hold>`).

  Note what this is NOT: counting the slots a class occupies and comparing
  against `reachableSlots`. The watchdog reads only the database, where that is
  unanswerable (see above); the slot ledger now answers it for the health row,
  but "did anything in this class drain" stays the better test here — it is
  exact, free, and true of the class rather than of this instant's occupancy.
- **`queue-dead-job`** (variant `error`) — terminally-failed jobs
  (`attempts >= max_attempts AND locked_at IS NULL`, the same predicate
  `reconcileDeadJobs` uses), grouped by `payload->>'jobName'`. **One report per
  distinct jobName** (fingerprint `queue-dead-job:<jobName>`), so a retry-storm of
  one broken job collapses to a single report while distinct broken jobs get
  distinct reports (investigation task on demand).
- **`queue-backlog`** (variant `warning`, escalates to STALLED) — depth/stall.
  Trips when `readyCount > backlogDepthThreshold` **or** the oldest ready job is
  overdue past `oldestOverdueMinutes`. `stalled = lockedCount === 0 && overdue`
  (the worker is making no progress). **One rolling report per worktree**
  (fingerprint `queue-backlog:rollup`; the reports unique index is
  `(fingerprint, worktree)`, so worktrees never collide). When a threshold trips
  the payload is **enriched** with `topReady` — a top-N per-jobName breakdown
  (`queryBacklogByJobName`) attributing which jobs are filling the ready queue.
  The extra query runs only on the already-tripped path, so the healthy path
  stays aggregate-only. `topReady` is **optional** so reports stored before this
  field existed still parse.
- **`queue-slot-hog`** (variant `warning`) — slot-hogging, **per class**. A job
  holding a worker slot far longer than its declared class says one run may
  starves the queue **even while `lockedCount > 0`** — the exact wedge the
  backlog `stalled` signal (which only trips at 0 locked) cannot see.
  `checkSlotHogs` collapses `queryRunningJobs()` to the longest-held slot per
  jobName and files one report per jobName over its class's threshold. **One
  report per distinct jobName** (fingerprint `queue-slot-hog:<jobName>`).

  **Measured against the deadline, not the ceiling.** A class's `ceilingMs` is
  defined on WORK; a locked graphile row carries only `locked_at`, so HOLD is all
  this detector can see. So it compares against the one class number that is also
  defined on hold — `deadlineMsFor(hold)`, the point at which a run is aborted —
  at `slotHogDeadlineFraction` of it (default 0.5 → 30s / 5min / 30min). The
  fraction is constrained strictly below 1, so **warn-before-kill is structural**:
  this report always precedes `job-deadline-exceeded`, for every class, at every
  settable config value.

  When the excess IS wait rather than work, `queue-slot-blocked` says so exactly,
  by name of the gate. The two are complements — a genuinely blocked job trips
  both, and the second one carries the actionable half.

  Per class rather than one flat duration is the point: a `minutes` job holding a
  slot six minutes is doing what it declared (the old flat 5-minute threshold
  filed a report every night for `backup.run`), while an `instant` job holding one
  for six minutes has wedged a reserved floor slot — the ladder's new failure
  mode.
- **`queue-slot-blocked`** (variant `warning`) — **this job holds a slot to WAIT,
  not to work.** `jobs.dead-gc` was measured holding a worker slot for 77 seconds
  to do 254 ms of work, all of it blocked on `background-tx-acquire` — an
  admission gate entered *after* graphile had already handed over the slot. That
  is the pathology `serial` exists to eliminate, occurring system-wide through
  the DB lane gates, and reporting it as "slow" leads to the wrong fix
  (reclassify it) instead of the right one (stop entering a gate on a worker
  slot). **One report per distinct jobName**, payload refreshed each occurrence
  so the named gate is the current one.

  **Where the wait data comes from, and why not from the queue.** `lockedForMs`
  is hold and knows nothing about what the handler is doing inside it. The
  wait/work split exists only in the runtime profiler's in-memory `job` spans
  (`recordEntrySpan("job", jobName, …)` around `job.run()`), whose `waitTotalMs`
  and per-layer `waits` are exactly `chargeWait`'s admission-gate charges. So
  `checkSlotBlocked` diffs the profiler's cumulative per-label counters against a
  module-level baseline — the same pull-and-diff `debug/op-rate` does on the same
  profile — and trips when the average run waited ≥ `slotBlockedWaitSeconds` AND
  more than half its hold was that wait. Two accepted consequences:

  - **It is post-hoc.** Gates charge their wait when the wait *ends*, so a job
    blocked right now carries no wait yet — there is nothing to sample about it.
    Completed runs are the only exact answer, so completed runs are what it reads.
  - **It is per-backend**, because the profiler is per-process memory. That is
    the right scope: this backend is the one draining this worktree's queue.

  The span wraps `job.run()` only, so the reported hold excludes graphile's
  handover and the job-lock connect ahead of it — a sub-second sliver that makes
  the number an *under*-statement of the slot's true occupancy, never an over-one.
  It runs every 10th tick, not every tick: materializing the whole profile is far
  heavier than this watchdog's two bounded aggregates, and five minutes of runs
  average better than thirty seconds of them.

## Summary endpoint + MCP tool

- **`GET /api/debug/queue-health/summary`** (`queueHealthSummaryEndpoint`) — a
  single attributed snapshot: `{ concurrency, backlog:{readyCount, lockedCount,
  oldestOverdueMs}, classes, byJobName, running, dead }`, assembled from the jobs
  plugin's read-only introspection API.

  `concurrency` and `backlog` are the **all-classes rollup** and keep their
  original names and meaning, so every existing consumer parses unchanged.
  `classes` is pure addition: the same three depth numbers per tier, each paired
  with `reachableSlots`. Both come from the SAME `queryQueueBacklog()` result,
  which sums its per-class rows into the rollup — so the two views cannot
  disagree. Every `hold` field, and `classes` itself, is **optional** on the wire:
  the MCP tool parses this schema against a response from ANOTHER worktree's
  backend, which may predate the ladder, and "absent" is a different statement
  from any default we could invent.
- **`get_queue_health`** MCP tool — proxies to the summary endpoint through the
  gateway (the `get_runtime_profile` gateway-proxy pattern), so it always reads
  the target worktree's live backend. `worktree` arg (defaults to the
  conversation's own worktree; pass `"singularity"` for main). Its description
  **interpolates the runner ladder** from `RUNNERS` / `HOLD_SPECS` rather than
  describing it, and states the two things the data cannot answer — an agent
  reads that description to know which question to ask about a stalled queue, so
  it earning its length matters more than it being short.

## Health row and pulse

The health report's **Job queue** row (`HealthReport.Row`, id `job-queue`) is
this plugin's too: it owns the queue thresholds. Design:
[`research/2026-09-11-global-job-queue-health-row.md`](../../../../research/2026-09-11-global-job-queue-health-row.md).

- **`queue-health.pulse`** — declared `queuePulse = liveValue(…)` in
  `core/pulse.ts` (pushed, not preloaded, no placeholder: not loaded yet is
  `pending`), served `queuePulseServed = serveValue(queuePulse, { source:
  "external", … })` in `server/internal/pulse.ts`, read with `useLive(queuePulse)`
  in `useQueuePulse`. Its loader reads the slot ledger + forfeit registry (memory)
  and three bounded jobs queries (`queryQueuePulse`, `queryOldestWaiting`,
  `queryRecentDeadJobs` over 24 h). Every array in the schema is `.max()`-bounded.
  Not boot-critical. The joins live in the pure `assemble-pulse.ts`.
- **No poll.** Notified by `onQueueActivity` (start / complete / insert / the jobs
  plugin's own mutations), throttled to one load per second (`throttleMs: 1000`),
  plus ONE timer armed at the verdict's `nextChangeAt`. A wedged queue emits no
  events, so without the timer it would stay green forever; the timer fires at the
  instant the answer changes, not to check whether it did. Both run only while a
  tab is subscribed: `whileSubscribed` hands them the value's `notify`, and its
  stop removes the listener and clears the timer — a load with no subscriber (an
  HTTP read) arms nothing.
- **The verdict** (`core/verdict.ts`, pure, bun-tested) — per class, on the
  class's OLDEST waiting row: amber at `10 × pickupTargetMsFor(c)`, red at
  `deadlineMsFor(c)`. Also amber: a running job past the slot-hog line
  (`slotHogDeadlineFraction × deadline`, the same line `queue-slot-hog` files
  at, so dot and bell agree; a forfeited slot is always stuck), and a death within
  `deadJobAttentionMinutes`. Summary: worst cause first, at most two, ages
  phrased by the threshold crossed ("10m+") so the text stays true between
  pushes.
- **Serial-lane rows never colour.** A row queued behind a held `serial` lane
  waits by design; counting it would turn correct serialization into an alarm.
  `queryQueuePulse` excludes them from `waitingForSlot`; the detail lists the
  count separately.
- **Bars measure reach**: a class's `busy` counts every slot on a runner that
  serves it, whatever it is running, so the three numerators can sum past the
  pool. Pickup stats (`getPickupStats`) describe the past and never colour the
  dot.

## All six kinds are `duressExempt`

A queue in trouble and a host under duress are overwhelmingly the same event, so
without the flag `recordReport`'s shed gate buffers exactly the reports that
describe the outage — and can drop them on buffer overflow at peak. That was the
second, quieter silencer on 2026-08-17: even a monitor that ran would have had
its report swallowed. Same argument `duress-shed` and `duress-episode` make:
these reports ARE the durable record of the condition, so shedding them loses the
only evidence there was one.

## Thresholds (config_v2, mirroring slowOpConfig)

`enabled = true`, `backlogDepthThreshold = 200`, `oldestOverdueMinutes = 10`,
`slotHogDeadlineFraction = 0.5` (× the class's deadline),
`slotBlockedWaitSeconds = 5`, `wedgeMinutes = 3` (also the floor of each class's
starvation window), `deadJobAttentionMinutes = 60` (health row only; 0 = dead
jobs never colour it). Read live via `getConfig`, editable in
Settings → Config. The 30s tick interval is **not** here — see above.

`slotHogDeadlineFraction` is a fraction rather than a duration, so the alarm
scales with what each job declared instead of restating a number the class table
owns. Its `(0,1)` bounds are what make warn-before-kill structural — do not widen
them to include 1, which would put the warning on the same instant as the abort.

## Why per-backend and cheap

- **Per-backend** — every worktree backend runs its own graphile worker against
  its own DB fork, so dead/backlog state accumulates per-DB and must be sampled
  per-DB. As an interval this is automatic (each backend runs its own), where the
  scheduled job had to say `perWorktree: true`.
- **Aggregate queries, bounded row fetches** — the healthy path is one backlog
  aggregate + one bounded currently-locked scan (plus the dead-job aggregate and
  the profile diff, each every 10th tick); the per-jobName backlog breakdown
  fetches only on the already-tripped path. Negligible cost; reports fire only on
  a tripped threshold (silent when healthy), and the engine's velocity limiter +
  dedup absorb bursts. All six kinds set `notifCooldownMs ≈ 10 min` so a
  persistent problem re-alerts the bell periodically without spamming — which is
  also the engine's re-alert floor, so these kinds simply sit on it (a cooldown
  is only ever a raise; no kind can ask for silence).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Queue-health report renderers: one-line Debug → Reports summaries for the queue-wedged, queue-class-starved, queue-dead-job, queue-backlog, queue-slot-hog, and queue-slot-blocked kinds, plus the threshold config registration, and the health report's Job queue row: per-class slot bars, the jobs that explain its colour, pickup-time stats, and an Open queue action. Queue-health watchdog: a 30s interval on the backend's own event loop — deliberately NOT a scheduled job, which would queue behind the wedge it exists to detect — that samples the graphile queue and files deduped reports for a wedged queue (every slot on every runner held by the same live jobs while ready work starves), a starved hold class (one tier of the runner ladder whose head has not moved for its own window, which is how the reserved-slot ladder is verified in production), a job holding a slot to WAIT on an admission gate rather than to work (read off the runtime profiler's job spans, which carry the wait/work split a graphile row cannot), backlog/stall, per-class slot-hogging, and terminally-dead jobs, through the existing reports engine. All six kinds are duressExempt. Also exposes a per-class queue-health summary endpoint + the get_queue_health MCP tool, and the push-based queue-health.pulse resource behind the health report's Job queue row (slot-ledger occupancy, waiting/stuck/dead jobs, pickup stats and a verdict whose next threshold crossing arms one timer).
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "queue-health"
    - `Reports.KindView` → `DeadJobSummary`
    - `Reports.KindView` → `BacklogSummary`
    - `Reports.KindView` → `SlotHogSummary`
    - `Reports.KindView` → `SlotBlockedSummary`
    - `Reports.KindView` → `ClassStarvedSummary`
    - `Reports.KindView` → `WedgedSummary`
    - `HealthReport.Row` "Job queue" → `QueueDetail`
  - Uses:
    - `apps-core/tabs.navigate`
    - `config_v2.ConfigV2`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.foldResource`
    - `primitives/live-state.useNotificationsChannelStatuses`
    - `primitives/loading.Loading`
    - `reports.Reports`
    - `shell/health-report.HealthReport`
- Server:
  - Contributes:
    - `ConfigV2.Register` "queue-health"
    - `resource.declare` "queue-health.pulse"
    - `report-kind` "queue-backlog"
    - `report-kind` "queue-class-starved"
    - `report-kind` "queue-dead-job"
    - `report-kind` "queue-slot-blocked"
    - `report-kind` "queue-slot-hog"
    - `report-kind` "queue-wedged"
  - Uses: 33 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/jobs` ×24
    - `config_v2` ×2
    - `reports` ×2
    - `infra/background/timer.defineTimer`
    - `infra/endpoints.implement`
    - `infra/mcp.Mcp`
    - `network/live.serveValue`
    - `tasks/tasks-core.getConversation`
  - Exports (values): `queueHealthTickOnce`
  - Register:
    - `mcpTool('get_queue_health')`
    - `defineTimer('queue-health.watchdog')`
  - Resources: `queue-health.pulse` (push, notified)
  - Routes: `GET /api/debug/queue-health/summary`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/float/config.floatField`
    - `fields/int/config.intField`
    - `infra/endpoints.defineEndpoint`
    - `infra/jobs.deadlineMsFor`
    - `infra/jobs.HOLD_CLASSES`
    - `infra/jobs.HOLD_SPECS`
    - `infra/jobs.HoldClass`
    - `infra/jobs.HoldClassSchema`
    - `infra/jobs.pickupTargetMsFor`
    - `infra/jobs.TOTAL_JOB_SLOTS`
    - `network/live.liveValue`
  - Exports (types):
    - `QueueBacklogPayload`
    - `QueueClassPulse`
    - `QueueClassStarvedPayload`
    - `QueueDeadGroup`
    - `QueueDeadJobPayload`
    - `QueueFacts`
    - `QueueHealthSummary`
    - `QueuePulse`
    - `QueueRunningJob`
    - `QueueSlotBlockedPayload`
    - `QueueSlotHogPayload`
    - `QueueTone`
    - `QueueVerdict`
    - `QueueVerdictConfig`
    - `QueueVerdictResult`
    - `QueueWaitingJob`
    - `QueueWedgedPayload`
  - Exports (values):
    - `ATTENTION_WAIT_MULTIPLE`
    - `attentionWaitMs`
    - `criticalWaitMs`
    - `formatThresholdMs`
    - `isRecentDeath`
    - `isStuck`
    - `PickupStatsSchema`
    - `PULSE_DEAD_LIMIT`
    - `PULSE_DEAD_WINDOW_MS`
    - `PULSE_WAITING_LIMIT`
    - `QUEUE_TONES`
    - `QueueBacklogPayloadSchema`
    - `QueueClassPulseSchema`
    - `QueueClassStarvedPayloadSchema`
    - `QueueDeadGroupSchema`
    - `QueueDeadJobPayloadSchema`
    - `queueHealthConfig`
    - `queueHealthSummaryEndpoint`
    - `QueueHealthSummarySchema`
    - `queuePulse`
    - `QueueRunningJobSchema`
    - `QueueSlotBlockedPayloadSchema`
    - `QueueSlotHogPayloadSchema`
    - `QueueToneSchema`
    - `queueVerdict`
    - `QueueVerdictSchema`
    - `QueueWaitingJobSchema`
    - `QueueWedgedPayloadSchema`
    - `stuckHoldMs`
    - `waitTone`
- Exemptions:
  - Exempts itself from:
    - `timer/no-unlisted-timer` — `server/internal/watchdog.ts` (sanctioned)
    - `no-db-backed-notify` — `server/internal/pulse.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
