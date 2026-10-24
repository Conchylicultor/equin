# A job declares how long it may hold a slot, and short work has slots reserved for it

**Date:** 2026-08-19 · **Category:** global (infra/jobs, infra/events, debug/queue-health, debug/slow-ops) · **Status:** planned

> **Revision (same day).** The design — three classes, a nested reserved-floor ladder, 8 total
> slots with the heavy ceiling unchanged at 4 — is unchanged from the first draft. What changed
> is that the class boundaries were **asserted** there and are **derived** here (§"Why these
> boundaries"), plus two mechanism corrections that fell out of the measurement: class
> conformance is read off *work* time rather than wall-clock hold, and hold-≫-work becomes its
> own signal. The "order of magnitude / histogram valley" justification in the first draft was
> wrong and is removed — the literature does not say it and this system's histogram has no
> valleys.

## Context

Every job in a backend routes through one graphile task name (`JOB_TASK = "jobs.run"`)
into a single shared pool of `JOB_CONCURRENCY = 4` slots
(`plugins/infra/plugins/jobs/server/internal/constants.ts:8,14`). A 150 ms projection
refresh and a multi-minute `pg_dump | pg_restore` compete for the same four slots, and
nothing in `defineJob` declares how long a run may hold one. Four long handlers hold every
slot and everything behind them stops — `queue-wedged` exists precisely because that
happened, observed at 40+ minutes.

Event-driven work is doubly exposed. `emit()` produces one `events.dispatch` row per
matched trigger row, and that job's whole body is *resolve the target, validate the
payload, `target.enqueue()`* — a router measured at 26 ms of work. Today it queues in the
same pool as `database.fork`, so an event reaches its handler through **two** hops that can
each wait behind heavy work.

### This is Phase 5 of an existing design

`research/2026-08-17-global-bounded-job-execution.md` already designed this as **Phase 5
("lanes")**, and `research/2026-08-18-global-push-ledger-git-projection.md` filed it again
as a follow-up after pulling the pushes ledger off the queue entirely. Phases 0 and 1 of
that doc have shipped — the `queue-health` watchdog, cron `jobKey` dedup, and `serial`
(graphile `queue_name`, concurrency-1 per named lane). `ctx.signal` is threaded and inert.
**Phase 2 (the execution budget) has not shipped**, and this plan deliberately lands before
it; see "One declaration, two mechanisms".

This plan **supersedes Phase 5's four role-named lanes** with a duration-classed reserved
floor. Everything else in that doc stands.

## Intended outcome

1. A job that holds a slot for minutes can never take the last slot a millisecond-scale job
   needs. Routing latency stops depending on what heavy work happens to be running.
2. The heavy ceiling does **not** grow: at most 4 long-running jobs at once, exactly as
   today. The reservation is pure addition of cheap capacity.
3. No slot is stranded — a class that is idle lends its slots to shorter work.
4. A job's declared class is checkable against measured *work*, and a lie files a report
   naming the offender within one watchdog tick.
5. The same one declaration arms Phase 2's execution budget later, with no second migration
   of ~73 call sites.

---

## Why partition at all — the formal reason, and the measurement

Queueing delay does not scale with mean service time. It scales with its **second moment**
(Pollaczek–Khinchine, `Wq = λE[S²] / 2(1−ρ)`), so one slow job type sets the wait for
everything behind it however rare it is. The SITA paper states it directly: *"every metric
for the simple FCFS queue is dependent on `E[X²]`… if the workload is heavy-tailed, the
second moment of the service time explodes."*

Measured on `main` over a ~41 min window, all 45 live job types, via
`get_runtime_profile(kind: "job")`:

```
one pool (today)          E[S] =  978ms   √E[S²] = 19,168ms   CV² = 383
class instant  (<1s)      E[S] =   92ms   √E[S²] =    228ms   CV² = 5.1
class seconds  (1s–30s)   E[S] = 3,728ms  √E[S²] =  6,731ms   CV² = 2.3
class minutes  (≥30s)     E[S] = 164.5s   √E[S²] =  288.6s    CV² = 2.1
```

The mean says one second; the term that actually drives waiting says nineteen. Feeding the
window's arrival rate into P-K gives **≈ 87 s of expected queueing delay for every job
today**, `events.dispatch` included; partitioned, the `instant` class lands near **17 ms**.
Treat that as order-of-magnitude rather than prediction — each job's runs were approximated
at its mean, which *understates* variance — but a factor of ~1000× is not sensitive to the
assumption.

**Load is concentrated to a degree that matters for the design:**

```
59.4%  database.fork                      3 runs × 618,042ms
 8.8%  debug.op-rate-monitor              8 runs ×  34,349ms
 6.6%  debug.session-divergence-monitor   8 runs ×  25,584ms
 5.2%  page.attachment-block.reconcile  186 runs ×     874ms
```

## Why these boundaries

**The standard rule does not apply.** The only documented cutoff rule in the literature is
**SITA-E** — Size Interval Task Assignment with Equal Load (Harchol-Balter, Crovella &
Murta, *Performance Tools '98*; *JPDC* 59(2), 1999): *"define the size range associated with
each host such that the total work (load) directed to each host is the same."* Computed
against the table above, **no such partition exists** — `database.fork` alone is 68.6% of
all work time, more than double a fair third. Beyond SITA-E the literature offers no general
heuristic for how many classes to use or where to cut; the "order of magnitude / histogram
valley" framing in this doc's first draft has no source behind it, and the measured
histogram is roughly log-uniform across six decades with no valley to cut at.

**And the exact cutoff barely matters.** Sweeping the `instant` cutoff against a 2-slot
floor:

```
cutoff   100ms   2756 runs   ρ= 1.8%   Wq ≈   0.4 ms
cutoff  1000ms   3033 runs   ρ= 5.7%   Wq ≈  16.9 ms
cutoff 10000ms   3167 runs   ρ=11.6%   Wq ≈ 100.5 ms
```

Every value across two orders of magnitude is under 100 ms, because utilization is low. The
objective is **flat**: essentially all the benefit is the partition existing, and where the
line falls inside it is worth milliseconds. So the boundary is chosen to be **checkable and
stable**, not numerically optimal — a tuned millisecond value would buy nothing and would
drift.

**Hence a structural rule: each class is defined by what bounds the handler**, which the
code already states.

| `hold` | the bound is | how a reviewer checks it | slots |
|---|---|---|---|
| `instant` | no blocking I/O — indexed reads/writes, in-memory work | no network, no spawn, no model call | **8** |
| `seconds` | a timeout the handler passes itself — the model calls already do (`HAIKU_TIMEOUT_MS`, `timeoutMs: 60_000`) | `grep timeoutMs` in the handler | **6** |
| `minutes` | nothing short of the work — subprocess, `pg_dump`, Chromium, archive upload, an open-ended step machine | does it spawn, render, or upload? | **4** |

This mirrors GitLab, which pairs a numeric SLO with exactly such a categorical constraint: a
Sidekiq worker may not be `urgency :high` **and** have external dependencies.

### Prior art — this shape is standard, and modern

Every production job system isolates by workload duration; several document it in nearly
these words.

| system | mechanism | documented guidance |
|---|---|---|
| **GitLab** | `urgency :high / :low / :throttled` | `high` = 10 s queue + 10 s execution ("median < 1 second… 99% within 10 seconds"); `low` = 1 min queue, **5 min execution** |
| **Celery** | routing to dedicated workers | *"for the best performance route long-running and short-running tasks to dedicated workers"* |
| **River** (Go/Postgres) | `Queues{ n: {MaxWorkers} }` | *"a 'high effort' queue for jobs that are known to take a long time… helps sustain more timely throughput for other job kinds"* |
| **Oban** (Elixir/Postgres) | per-queue concurrency | *"a job in a single slow queue can't back up other faster queues"* |
| **Temporal** | separate task queues | *"Use separate Task Queues for distinct workloads… prevent one workload from starving another"* |
| **Sidekiq** | dedicated **process** per critical queue | for hard prioritization, *"dedicate a Sidekiq process exclusively to the critical queue"* |
| **Borg** | prod/non-prod + LS/batch appclass | *"High-priority LS tasks… are capable of temporarily starving batch tasks"* |

GitLab's three urgency levels at ~1 s / 10 s / 5 min are the closest match and land on the
same lines this system's data suggests, arrived at independently. Sidekiq's note is the
argument for separate runners over graphile `priority`: when you need a guarantee rather
than a weighting, the sanctioned mechanism is a dedicated **process**, not a priority number.

*Not taken:* **LAS / Foreground-Background** — schedule whoever has received least service,
requiring no declaration at all and provably good on heavy tails. It needs preemption, which
a run-to-completion job queue cannot offer.

---

## Design

### The declaration

`DefineJobSpec` gains one **required** field, answering one question: *how long may one run
of this handler hold a worker slot?*

```ts
/**
 * The timescale one RUN of this handler occupies a worker slot. Not workflow
 * duration: `ctx.waitFor` / `ctx.sleep` RETURN from `run` and release the slot,
 * so a workflow may span days while every one of its runs is `instant`.
 *
 * Declared from what BOUNDS the handler, not from its observed mean — see the
 * table in this plan. A model call with a 30s timeout is `seconds` however fast
 * it usually returns.
 *
 * This is the only declaration of a job's duration class. It picks the
 * reservation tier today and, when
 * `research/2026-08-17-global-bounded-job-execution.md` Phase 2 lands, the
 * deadline that aborts `ctx.signal`. There is deliberately no second field, so a
 * lane and a budget cannot disagree.
 */
export type HoldClass = "instant" | "seconds" | "minutes";
```

### The mechanism: nested runners over per-class graphile tasks

The reservation **must** happen at fetch, not after dispatch. That is the whole lesson of
`serial` (`registry.ts:180-223`): an in-process gate entered after graphile hands over a job
turns one stuck job into N stuck slots. graphile's fetch query partitions on
`task_id = any($2::int[])`
(`node_modules/.bun/node_modules/graphile-worker/dist/sql/getJob.js`, the `with j as (…)`
block), so **a runner physically cannot see a task identifier absent from its own
`taskList`.** One task identifier per class, three runners with nested task lists:

```
runner            taskList                                        concurrency
────────────────────────────────────────────────────────────────────────────
floor    jobs.run.instant                                              2
mid      jobs.run.instant  jobs.run.seconds                            2
wide     jobs.run.instant  jobs.run.seconds  jobs.run.minutes          4
                                             + jobs.run (legacy)
```

Ceilings fall out: `minutes ≤ 4` (unchanged from today's total), `seconds ≤ 6`,
`instant ≤ 8`. Two slots are permanently unreachable by anything that can run for minutes.

Nesting rather than disjoint queues is the one place this departs from the systems above,
and it is deliberate: a shorter class always inherits a longer class's idle slots, so the
only capacity ever stranded is the 2-slot floor itself. See risk 1 for what that costs.

**graphile `priority` decides preference inside a runner.** `getJob` orders
`priority asc, run_at asc`, and today every row carries the column default. Stamping
`priority` from the class — `minutes: 0`, `seconds: 1`, `instant: 2` — makes each runner
prefer the longest class it is allowed to serve, so a class's own tier fills before it
spills into a narrower one. Priority alone could never fix this (it reorders *pick* time,
never *hold* time); paired with the task partition it is the last piece.

**Legacy `jobs.run` stays registered in the wide runner forever.** It costs one `taskList`
entry and makes a stranded row impossible by construction: any row not re-pointed —
mid-deploy, or written by an older backend — still runs, in the most conservative tier.

### One declaration, two mechanisms

`hold` is not a lane name that happens to correlate with duration; it *is* the duration
statement. Today it selects the reservation tier. When Phase 2 lands, `holdCeilingMs(hold)`
becomes the deadline that aborts `ctx.signal` — the same field, read a second way. This is
why Phase 5 lands before Phase 2 here despite the doc's ordering: the ~73 `defineJob` call
sites churn once, and a lane can never disagree with a budget because there is only one
thing to declare.

### Conformance is measured on work, not on hold

Slot-hold time is substantially **not a property of the job**. From the same profile:

```
100% wait   jobs.dead-gc                       hold=77,111ms   work=  254ms
 97% wait   attachments.orphan-sweep           hold= 2,230ms   work=   62ms
 91% wait   conversations.hibernate-idle       hold=   907ms   work=   81ms
 85% wait   mail.sync-tick                     hold= 1,525ms   work=  230ms
 83% wait   debug.session-divergence-monitor   hold=25,584ms   work=4,224ms
```

`jobs.dead-gc` held a worker slot for 77 seconds to do a quarter-second of work, blocked on
`background-tx-acquire` — a *different* admission gate, entered after graphile had already
handed it a slot. That is the same pathology `serial` exists to eliminate, occurring
system-wide through the DB lane gates.

Two consequences, both design changes:

1. **Class conformance reads work time, defined as `durationMs − waitMs`.** Today the
   slow-op hook compares `span.durationMs` against the threshold
   (`plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts:36`), which
   includes wait — so a correctly-classified `instant` job would file false slot-hog reports
   every time the DB background lane is busy. `SlowSpan` already carries `waitMs`, so this
   is a change of which quantity is compared, for `kind === "job"` only. (Verified against
   the profile: `77,111 − 76,858 = 253 ≈ selfMs 254`; the identity holds for every row.)
2. **Hold ≫ work becomes its own signal.** "Held a slot for 77 s to do 254 ms of work" names
   a real bug — a gate entered after dispatch — where "slow job" does not. New report kind
   `queue-slot-blocked` (below).

### Enforcement, honestly placed on the ladder

- **Rung 2 (tsc):** `hold` is required, on both arms of the `DefineJobSpec` union. A partial
  migration is not expressible.
- **Rung 4 (loud runtime):** the per-class ceiling, applied to work time. A job declaring
  `instant` that spends 10 s *working* files `queue-slot-hog` naming it, every tick, until
  it is reclassified or fixed. When Phase 2 lands, the same lie becomes an abort.
- **Rung 3 is deliberately empty, and that is the finding.** Phase 5 proposed a reviewed
  membership file listing which jobs may claim which lane. Against a duration axis that file
  is a static restatement of a runtime fact, editable by every plugin that adds a job, and
  verifiable by nobody. The truth is measured, so it is enforced where it is observable. Say
  so in the code comment rather than reaching for a check that cannot know the answer.
- A **module-eval assert** in `register()` when a job's `slowThresholdMs` exceeds its class's
  ceiling — both numbers are right there, and disagreeing is a wiring bug.

---

## Implementation

### 1. The class table — `plugins/infra/plugins/jobs/core/hold.ts` (new)

`core/`, not `server/`, because the Debug → Queue UI renders the class per row. Closed set,
plain data (per CLAUDE.md: a closed list both runtimes need is data in `core/`, not a slot):

```ts
export type HoldClass = "instant" | "seconds" | "minutes";

/** Ordered shortest → longest. */
export const HOLD_CLASSES = ["instant", "seconds", "minutes"] as const;

export interface HoldClassSpec {
  readonly hold: HoldClass;
  readonly label: string;
  /** Graphile task identifier. The ONE spelling; nothing composes this string. */
  readonly task: string;
  /** Graphile `priority` (lower wins): longest class preferred inside a runner. */
  readonly priority: number;
  /** Ceiling on WORK time (durationMs − waitMs). Slot-hog threshold today,
   *  Phase 2's execution deadline later. Generous — see "flat objective". */
  readonly ceilingMs: number;
  /** Total slots a row of this class can ever reach. Derived from RUNNERS. */
  readonly reachableSlots: number;
}
```

Plus `LEGACY_JOB_TASK = "jobs.run"` and `ALL_JOB_TASKS`, exported so `introspection.ts` and
`resources.ts` compose them rather than re-typing.

### 2. Runner table — `server/internal/constants.ts`

Replace `JOB_TASK` / `JOB_CONCURRENCY` with:

```ts
export const RUNNERS = [
  { id: "floor", serves: ["instant"],                        concurrency: 2 },
  { id: "mid",   serves: ["instant", "seconds"],             concurrency: 2 },
  { id: "wide",  serves: ["instant", "seconds", "minutes"],  concurrency: 4, legacy: true },
] as const;

export const TOTAL_JOB_SLOTS = /* sum of concurrency = 8 */;
```

**Delete the `JOB_CONCURRENCY` export outright** (`server/index.ts:62`) rather than
retiring it, so "size this by the old single number" has no spelling. `reachableSlots` per
class is derived from `RUNNERS` here. In-code readers are `job-lock.ts` and `queue-health`,
both changed below; `fork-gate.ts` mentions it only in a comment — update the prose.

### 3. Registry — `server/internal/registry.ts`

- `BaseJobSpec` gains `hold: HoldClass` (required). `RegisteredJob` carries it.
- `graphileSpecFor` gains `taskIdentifier` and `priority` from the job's class, alongside
  the existing `queueNameFor`. Same argument as the queue name (`registry.ts:386-394`): the
  task and priority are properties of the **registered job**, never a caller argument, so
  the five insertion sites cannot drift.
- `UNSAFE_insertJobRow` passes `spec.task` instead of the constant; the shared-tx raw SQL
  gains `priority := $7` and takes its identifier from the spec.
- `register()` asserts `slowThresholdMs ?? 0 <= ceilingMs`.

### 4. Worker — `server/internal/worker.ts`

- **One shared `pg.Pool`** handed to all three `run()` calls via `RunnerOptions.pgPool`
  (verified: `dist/lib.js:187-189` — a caller-supplied pool is *not* `.end()`ed on release,
  unlike an internally-created one). Size it `TOTAL_JOB_SLOTS + RUNNERS.length` = 11; three
  independent default pools would be 30 connections per backend.
- `startWorker()` → `startWorkers()`, returning `Runner[]`, one `run()` per entry in
  `RUNNERS` with `taskList` built from `serves` (plus `LEGACY_JOB_TASK` on `wide`). All
  three dispatch into the **same** `dispatch()` — the class picks the slot, never the handler.
- Pass `noHandleSignals: true` on every runner; three runners must not each install signal
  handlers when `onShutdown` already stops them.
- **Cron items go to the wide runner only** (`parsedCronItems: []` for the other two), and
  `buildCronItems` sets `task` and `priority` from the job's class, keeping the existing
  `jobKey` / `jobKeyMode: "preserve_run_at"` / `queueName` arguments untouched.
- New `repointHoldTasks()`, run inside `startWorkers()` **before** `run()`, written as a
  standing invariant rather than a one-shot migration: *on every boot, a pending row sits on
  the task and priority its `jobName`'s current class declares.* One statement per class:

  ```sql
  UPDATE graphile_worker._private_jobs j
     SET task_id = <class task id>, priority = <class priority>
   WHERE j.locked_at IS NULL
     AND j.payload->>'jobName' = ANY($1::text[])
     AND (j.task_id <> <class task id> OR j.priority <> <class priority>)
  ```

  The registry is fully populated at the register phase, before `onReady`, so the name lists
  are available. Locked rows are untouched — they finish under the wide runner's legacy
  entry and their retry, if any, lands re-pointed on the next boot. This makes future
  reclassification safe by construction, not just this deploy.

### 5. Introspection and resources

- `introspection.ts:21`: `jobTaskScope` becomes `t.identifier = ANY(${ALL_JOB_TASKS})`.
- New `jobHoldExpr`: a `CASE` over `t.identifier` built from `HOLD_CLASSES` so it cannot
  drift from the table — legacy `jobs.run` maps to `minutes`, matching where it runs. Lives
  next to `jobLockHeldExpr`, the file that owns the graphile coupling.
- `queryRunningJobs` / `queryQueueBacklog` / `queryBacklogByJobName` gain `hold`, and
  `queryQueueBacklog` groups its ready/locked counts by class.
- `resources.ts:64` composes `ALL_JOB_TASKS`; `core/resources.ts` `JobRowSchema` gains
  `hold: HoldClassSchema.optional()` so a live-state payload from a pre-deploy backend still
  parses.

### 6. The ~73 `defineJob` call sites

Assign by the structural rule in "Why these boundaries" — *what bounds this handler?* — not
by observed mean, and **not by observed hold**. Three worth calling out:

- `conversation-progress.classify` — shells out to `git merge-base` / `diff` / `ls-files`.
  Bounded by a subprocess it does not time out. `seconds`.
- `jobs.dead-gc` — measured at a **77 s hold**, of which 254 ms was work; the rest was
  blocked on `background-tx-acquire`. One bounded SQL transaction ⇒ `instant`. The hold is
  a separate defect, surfaced by `queue-slot-blocked` (§9).
- `page.attachment-block.reconcile` — an earlier draft of this plan called it `minutes` on
  the strength of a 1050 s `max_ms`. Reading the handler
  (`plugins/page/plugins/attachment-block/server/internal/reconcile.ts`) shows one indexed
  `SELECT` over a page's blocks and an indexed `set()` per block — no network, no spawn, no
  model call ⇒ **`instant`**. The observed tail is `background-tx-acquire` wait plus one
  un-batched round-trip per block. If its *work* ever does exceed 10 s, `queue-slot-hog`
  says so and names the real defect (the unbatched loop) rather than blessing it with a
  bigger class. This is the whole reason conformance moved to work time; treat it as the
  worked example.

Sanity-check every assignment against measurement before shipping — but read the handler to
decide. `slow_ops.max_ms` and the profile's `avgMs` are **wall-clock including gate wait**,
so they catch a wrong *bound* and will actively mislead about a job that merely waits:

```sql
SELECT operation, count, round(max_ms) max_ms, round(total_ms/NULLIF(count,0)) avg_ms
FROM slow_ops WHERE operation_kind = 'job' ORDER BY max_ms DESC;
```

Note this table is threshold-gated at 3 s, so it shows only the tail and contains **no job
with an average under 3 s** — it can confirm a `minutes`/`seconds` assignment but says
nothing about `instant`. For that, `get_runtime_profile(kind: "job")` is the unbiased view.

`defineRetention` (`plugins/infra/plugins/retention/server/internal/define-retention.ts:116`)
forwards `hold: "instant"` for all 11 sweeps — one bounded `DELETE` each.

**`events.dispatch` is `instant`** (`plugins/infra/plugins/events/server/internal/dispatch-job.ts:32`,
measured 26 ms of work over 1405 runs). That is the fix for the double hop: routing lands in
the reserved floor and can never queue behind heavy work, while the target's *execution*
lands in whatever class the target declares. `jobs.resume` is `instant` for the same reason.

*Considered and rejected:* collapsing `emit()`'s N per-trigger dispatch rows into one row
carrying all matched trigger ids. It would halve the rows, but one trigger's
`NonRetryableError` would then dead-letter routing for its siblings — a failure-isolation
regression. `dedup: "none"` on dispatch is also correct as-is: each trigger row is a
distinct binding, and deduping would silently drop deliveries. With `instant`, N cheap
routing rows drain in the reserved floor, which is what made the fan-out expensive.

### 7. `job-lock.ts`

`max: JOB_CONCURRENCY` → `max: TOTAL_JOB_SLOTS` (`job-lock.ts:57`). Every in-flight job
across every runner holds one of these for its whole handler lifetime; leaving it at 4 while
8 slots exist would block four handlers inside `withJobLock`'s `pool.connect()` **while they
already hold graphile slots** — a new wedge with no symptom. Deleting the `JOB_CONCURRENCY`
export is what makes this undriftable.

### 8. `debug/slow-ops` — conformance on work time

`install-slow-span.ts:36` compares `span.durationMs < threshold`. For `kind === "job"` only,
compare `span.durationMs - span.waitMs`. The threshold itself comes from the job's class
ceiling via `resolveSlowThreshold` (`resolve-threshold.ts:28`), with the existing per-job
`slowThresholdMs` still overriding. Everything else keeps using wall-clock.

### 9. `debug/queue-health`

- `summary-endpoint.ts:25` and the `get_queue_health` MCP description: a `classes[]` array
  (`hold`, `reachableSlots`, `readyCount`, `lockedCount`, `oldestOverdueMs`) with the
  all-classes rollup retained so existing consumers keep parsing. The tool's description
  ("a single shared pool… all jobs route through one `jobs.run` task") becomes false and
  must be rewritten.
- `watchdog.ts:165`: `saturated` becomes `running.length >= TOTAL_JOB_SLOTS`. The existing
  `queue-wedged` detector stays **global** — it is about the whole pool stopping, and is
  still exactly right.
- New report kind **`queue-class-starved`** (`duressExempt: true`, like the other four). A
  class is starved when, continuously for `wedgeMinutes`, it has ready work **and the oldest
  ready row of that class is the same job id across ticks** — nothing in that class drained.
  Cheap (the per-jobName ready aggregate exists; add the class), exact, and needs no
  per-runner attribution, which the DB cannot give. It is the signal that would have named
  the 40-minute `tasks.push-ingest` lag, and it is how the reservation is verified in
  production rather than asserted.
- New report kind **`queue-slot-blocked`** (`duressExempt: true`): a running job whose
  `waitMs` exceeds both a floor (say 5 s) and half its hold. Names the gate from the span's
  `waits` map, so the report reads *"`jobs.dead-gc` held a slot 77 s to do 254 ms of work,
  blocked on `background-tx-acquire`"*. This is the pathology `serial` was built to remove,
  and it is currently invisible.
- Per-class `runningJobMinutes` for `queue-slot-hog`, from `ceilingMs`.

### 10. `jobs:no-raw-addjob` check and the harness

Extend the existing check (`plugins/infra/plugins/jobs/check/index.ts`) so a bare
`"jobs.run"` task-identifier string literal is also confined to `core/hold.ts` and the
allowlist. `plugins/infra/plugins/events-test/server/internal/cron-dedup.ts:56` hardcodes
its own copy — point it at `LEGACY_JOB_TASK`.

### 11. Docs

`plugins/infra/plugins/jobs/CLAUDE.md` gains a "Hold class: what bounds this handler" section
covering the ladder, why the reservation is at fetch and not after dispatch, why conformance
is measured on work rather than hold, why rung 3 is empty, and the standing re-point
invariant. Then `./equin build` regenerates the plugin reference
(`plugins-doc-in-sync` fails otherwise).

---

## Ordering

Each step ends with `./equin build`.

1. `core/hold.ts` + `constants.ts` runner table, `hold` required on `DefineJobSpec`, all ~73
   assignments — with `taskFor()` still returning `LEGACY_JOB_TASK` and no priority stamped.
   **Zero runtime change**; the 73-file churn lands on its own and reviews as pure data.
2. The runtime: shared pool, three runners, per-class task + priority in `graphileSpecFor`
   and `buildCronItems`, `repointHoldTasks()`, `job-lock` sizing, `JOB_CONCURRENCY` deleted.
3. `slow-ops` work-time conformance, then `queue-health` per-class reporting, then
   `queue-class-starved` + `queue-slot-blocked`, then the check extension.

## Verification

- **The reservation holds.** Enqueue 6 `minutes` jobs that block on a held gate. Assert via
  `query_db` that exactly 4 are locked and the other 2 sit `locked_at IS NULL`, then enqueue
  an `instant` job and assert it runs immediately. This is the incident, inverted — the
  assertion that matters most. Belongs beside the existing harnesses as
  `POST /api/events-test/hold-reservation` (that file already hosts `serial-queue`,
  `queue-lock-no-steal`, `cron-dedup`, `crash-recovery`).
- **No stranding.** With no `minutes` work queued, enqueue 8 `instant` jobs and assert all 8
  run concurrently — the wide runner's slots are reachable by short work.
- **Re-point invariant.** Enqueue an `instant` job, stop the worker, `UPDATE` its row onto
  the legacy task, restart, assert it returns on `jobs.run.instant` with priority 2. Then
  flip a job's declared class in a test build and assert its pending row moves on boot.
- **Serialization still composes.** Re-run `POST /api/events-test/serial-queue` — a `serial`
  job now also carries a class; assert both the queue lock and the task partition hold.
- **Cron.** Re-run `POST /api/events-test/cron-dedup`; assert the tick lands on the job's
  class task with the class priority and that `run_at` still does not move.
- **Work-time conformance.** A job that sleeps behind a held gate for 30 s but works for
  50 ms must file `queue-slot-blocked` and **not** `queue-slot-hog`.
- **Connections.** After deploy, `SELECT count(*), datname FROM pg_stat_activity GROUP BY 2`
  against `max_connections = 500` with ~16 live backends. Expected per backend: 11 shared
  graphile + 8 direct lock = 19, up from 14.
- **Re-measure.** A week after deploy, re-run `get_runtime_profile(kind: "job")` and
  recompute per-class CV². The `instant` class should sit near 5; a large rise means a
  misclassified job, and `queue-slot-hog` should already have named it.

## Risks to watch after deploy

1. **The floor is capacity that heavy work can never reclaim — and that has a measured
   price elsewhere.** The Borg paper reports that *"segregating prod and non-prod work would
   need 20–30% more machines in the median cell to run our workload"*; Borg therefore uses
   quota plus reclamation rather than hard reservation, and GitLab's urgency shards are
   opt-in with the docs discouraging most installs from using them. Here the ladder reclaims
   upward only: short work inherits idle `minutes` slots, but `minutes` can never touch the
   floor's 2 slots, which sit idle at ~2% `instant` utilization.
   **The cheaper variant, recorded as not taken:** two runners — `{instant, seconds}` at 1
   and `{all}` at 3 — keeps the total at 4 slots and ~15 connections and still guarantees
   `minutes` cannot take the last slot, at the cost of `minutes ≤ 3`. Rejected deliberately:
   heavy-work throughput (fork + spawn on an agent launch) is worth more here than the two
   idle slots. If risk 2 or 3 bites, this is the fallback.
2. **Connections, 14 → 19 per backend.** Mitigated by design (one shared pool for three
   runners rather than three default-10 pools), but ~16 backends against
   `max_connections = 500` leaves less headroom. Verify on day 1; the fallback is risk 1's
   two-runner variant.
3. **Total slots 4 → 8.** `JOB_CONCURRENCY` was never the CPU budget — `host-admission`'s
   pools are, and job subprocesses are already `darwinbg`-demoted — and the *heavy* ceiling
   is deliberately unchanged at 4. Still, watch loadavg and the sentinel's onset detector.
4. **graphile's named-queue fetch strategy is unaffected**, but the task-id array grows from
   1 to 4. `getJob` filters `task_id = any($2::int[])` on an indexed column; cost is nil.
   Confirm no fetch-latency regression in the `job` spans.
5. **A misclassified `instant` job** now runs in a 2-slot floor it can wedge. Strictly better
   than wedging the whole pool, and `queue-slot-hog` names it within a tick — but it is the
   new failure mode, so the report copy should say so.
6. **Phase 2 is still not shipped.** A `minutes` job that hangs forever still holds one of
   the 4 wide slots indefinitely; this plan bounds the *blast radius* of that, not the hang.
   `research/2026-08-17-global-bounded-job-execution.md` Phases 2–4 remain the fix, and they
   now have their declaration waiting for them.
