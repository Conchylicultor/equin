# Bounded job execution: no handler may hold a slot forever, and no wedge may be silent

**Date:** 2026-08-17 · **Category:** global (jobs, queue-health, reports, prototypes, worktree-cleanup, spawn) · **Status:** planned

## Context

On 2026-08-17 at 12:59 UTC main's job queue stopped, completely, for 70 minutes. It was
found by hand. Nothing reported it.

All four slots of the shared `JOB_CONCURRENCY = 4` pool were held by handlers that would
never return, and 690 ready jobs piled up behind them:

- 8 queued `git.refAdvanced` events — main stopped auto-building on `refs/heads/main`
  advances, and pushes stopped being ingested, so a conversation's review pane showed no
  pushes for work already merged.
- 2 `database.fork` + 2 `conversations.spawn` — **no new agent worktree and no new
  conversation could start.**
- Every scheduled monitor stacked up unboundedly: 57 copies each of six per-minute jobs,
  11 each of the five-minute ones — including `debug.queue-health-monitor`, whose entire
  purpose is to report this exact condition.

### The two bugs

Same shape — an unbounded wait inside a handler — reached two different ways. Only one of
them was needed to lose the whole queue.

**1. `prototypes.render-thumbnail` is a slot amplifier.**
`plugins/apps/plugins/prototypes/plugins/thumbnails/server/internal/render.ts:64` guards
Chromium with a process-local `createSemaphore(1)`, and the guarded block ends with an
un-timed `await browser.close()`. That never returned, so the permit never released. Every
timeout in that file (launch 30s, nav 20s, settle 3s, content 5s) bounds work *inside* the
gate; nothing bounds the wait *for* it.

Then the amplification. All three stuck jobs are renders of the same prototype
(`control-panel-date-filter`), saved three times in 14 seconds. The job's `dedup` by slug
cannot collapse them, because graphile cannot replace a row that is already locked — so
each save became a new row, was dequeued, and blocked forever on `renderGate.run()`.
**One stuck job converts each later job of its type into another stuck slot.** Three of the
four slots came from one bug.

**2. `worktree-cleanup.reap-stale` runs un-timed subprocesses inside a host-wide lock.**
`reapAttempt` → `removeWorktree` → raw `Bun.spawn(["git","worktree","remove", …])` with no
timeout, *while holding* a `worktree-mutate` flock slot. Fourth slot. In principle the worse
bug: that pool is `max(2, cpus/6)` slots **host-wide** and the job fans out 3 concurrent
reaps, so it can block new agent worktrees on every backend on the machine. It averaged
~108s even when healthy (`research/2026-07-07-global-background-work-priority-isolation.md`).

### Why nothing recovered, and why that was correct

The stuck-lock sweeper reclaims a row only when its session advisory lock is *absent* from
`pg_locks` — never on age. These handlers were genuinely alive, so it correctly left them
alone. That doctrine is load-bearing and is not up for revision: the previous age-based
lease stole ~25 live jobs in 8 days (`plugins/infra/plugins/jobs/CLAUDE.md`,
`research/2026-07-30-jobs-exact-liveness-advisory-locks.md`).

**The gap is not liveness detection. Nothing bounds how long "alive" may last.**

### Why nothing reported it — two silencers, not one

**Silencer 1.** `debug/queue-health` is itself `defineJob({ schedule: { cron: "*/5 * * * *" } })`.
It was queued behind the wedge it exists to detect. Its `queue-backlog` and `queue-slot-hog`
kinds both exist and both would have fired.

The doctrine is already written down, in this very plugin —
`stuck-lock-sweeper.ts:30-34`: *"Why this stays a raw setInterval and NOT a scheduled
defineJob: it is the recovery mechanism FOR the job system… Infra that recovers the job
system must not depend on the job system."* `debug/queue-health` was written afterwards, in
the same repo, violating it. That is the empirical case for enforcing it rather than
documenting it again.

**Silencer 2, found during design and not previously known.** `recordReport` shed-gates
every non-`duressExempt` kind during a host duress episode: `reportShed.admit(...)` buffers
the report and returns `{ reportId: null }`. A queue wedge is very likely to coincide with
host duress — the duress-episodes channel shows repeated trips on this box that day. So
even a watchdog that runs would have had its report buffered until the episode cleared.

### A third defect, found while investigating

`buildCronItems()` (`worker.ts:64-93`) passes no `jobKey` to `parseCronItem`, so the `dedup`
a job declares — honored on the `enqueue()` path — is **silently ignored on the cron path**.
Every tick inserts a new row forever. Hence 57 copies of each per-minute monitor, and a
thundering herd of stale ticks on recovery.

## Intended outcome

1. A handler cannot hold a slot indefinitely; if it tries, the failure is loud and bounded.
2. A stuck job of one type cannot consume more than one slot.
3. Cosmetic background work cannot starve the control plane even when legitimately slow.
4. A wedged queue cannot suppress its own alarm — through either silencer.
5. The unbounded waits that caused this become hard to write, not merely discouraged.

---

## Design

### Phase 0 — the alarm, and the pile-up (ship first, alone)

Both are small, neither depends on anything else, and together they are what makes the
*next* incident loud. Shipping observability first also means the riskier phases below are
themselves observed while landing.

**The watchdog lives in `debug/queue-health`, not in the jobs plugin.** My first instinct
was to put it beside the stuck-lock sweeper; that is blocked by the plugin DAG.
`plugins/reports/server/internal/record-report.ts:20` imports `recordNotification` from
`shell/notifications`, whose barrel imports a `defineJob` — so `jobs → reports →
shell/notifications → jobs` is a cycle, and `no cycles` is enforced. `queue-health` already
imports both `jobs` and `reports`, so this placement adds **zero new plugin edges**, and it
keeps queue *interpretation* (thresholds, config, report kinds) out of the load-bearing
mechanism-only `jobs` plugin.

New `queue-health/server/internal/watchdog.ts`: a raw `setInterval` (30s) started from
`onReady`, modeled on `stuck-lock-sweeper.ts` — module-level timer, `runTracked` wrapper,
`.catch → console.warn`, an exported `queueHealthTickOnce()` for forcing. Delete
`monitor-job.ts` outright rather than merely unscheduling it.

Cadence 30s gives six samples per three-minute window, so one slow tick cannot
false-negative. The healthy path is two aggregates over `_private_jobs` plus a `pg_locks`
scan bounded by the slot count; `queryDeadJobStats()` runs every 10th tick.

**One new report kind, `queue-wedged`.** Strictly the incident satisfied both existing
conditions, so no new kind was *needed*. But "something is slow" and "the queue is deep" are
routinely true and benign (`backup.run` trips slot-hog nightly). `queue-wedged` says the
thing an operator needs: *this lane has stopped draining*. A lane is wedged when,
continuously for 3 minutes: every slot is held, **and** the set of locked job ids is
unchanged across ticks, **and** `readyCount > 0`, **and** every locked row has
`alive === true` (otherwise the owner died and the sweeper owns it — do not double-report).
All four come from existing introspection; the only new state is a module-level
`Map<lane, {ids, since}>`.

**Set `duressExempt: true` on all four queue kinds.** Same argument `duress-shed` and
`duress-episode` already use: these ARE the durable record of the condition, so shedding
them loses the only evidence. Without this, Silencer 2 stays live.

**Cron dedup.** `buildCronItems` passes `jobKey: \`${job.name}:_\`` — identical to what
`enqueue()` derives for a singleton, so a manual enqueue and a cron tick collapse onto the
same row instead of racing. Two non-obvious constraints:

- **`jobKeyMode: "preserve_run_at"` is mandatory, not a preference.** graphile
  `sql/000018.sql:161-164` keeps the original `run_at` only in this mode while
  `attempts = 0`. Under the default `"replace"`, a pending row's `run_at` is pushed forward
  every tick — which (i) starves a `* * * * *` job in a merely-busy queue, and worse (ii)
  resets `oldestOverdueMs` to near-zero each minute during a wedge, making the backlog
  signal *quieter* than it is today. **The dedup fix and the observability fix only compose
  in this mode.**
- **Do not collapse `workflowRunId` into `jobKey`.** `jobKey` is queue-row identity (one
  pending row); `workflowRunId` is run identity (per tick, the memoization key for
  `_jobSteps`/`_jobWaits`). Merging them makes every tick of a scheduled workflow replay the
  first tick's cached steps forever.

Make the invariant a type error rather than a convention — `DefineJobSpec` becomes a union
where `schedule` requires `dedup: "singleton"`. Costs nothing: all ~22 scheduled jobs
already declare it, and a keyed schedule is meaningless anyway (the cron payload is always
`input.parse({})`).

Known behaviour to watch on day 1: when a tick fires while the previous run is still
locked, graphile clears that row's key and sets `attempts = max_attempts`. A *successful*
overlapping run is still just deleted, so nothing is lost; a *failing* one dead-letters after
one attempt instead of retrying. Only `mail.sync-tick` and `backup.run` can plausibly overrun
their interval — watch `queue-dead-job` for those two.

### Phase 1 — serialization at fetch time, so a stuck job costs exactly one slot

`DefineJobSpec` gains an optional `serial?: true | { with: string }`, plumbed to graphile's
`queue_name`. It works because graphile's fetch query filters on
`job_queues.is_available = true` (`getJob.js:72-74`): **a serialized job whose queue is busy
is never handed to a worker, so it occupies no slot while it waits.** That is the whole
difference from an in-process semaphore, which is entered *after* dispatch. `renderGate` is
deleted rather than fixed.

This is orthogonal to lanes, and both are needed: `queue_name` gives per-queue serialization
(concurrency exactly 1) and cannot express "control always has ≥3 slots"; lanes reserve
budgets and cannot express "one Chromium at a time".

**Five enqueue sites must carry the queue name**, or a serialized job escapes its own queue.
Derive it once (`queueNameFor(job)` feeding a single `graphileSpecFor(job, opts)`) and route
all five through it: `registry.ts` `utils.addJob` (~324) and the shared-tx raw SQL (~302,
add `queue_name := $N`); **`resume-job.ts:100`** (the target's resume re-enqueue — easy to
miss, and without it a suspended serialized job comes back outside its queue);
`worker.ts` `scheduleResume` (~205); `buildCronItems` (~88). Then a check banning
`utils.addJob` / `graphile_worker.add_job` outside `registry.ts` so a sixth cannot be written.

Two caveats:

- **Queue names must be a small fixed set.** Graphile auto-selects a slower fetch strategy
  when named queues exist (~843 jobs/s vs ~11.8k, per its own benchmark at
  `getJob.js:30-60`) — ample here, but per-instance names (one per prototype slug) are
  explicitly pathological. Serialize on the *resource*, never the input.
- **The sweeper must now reclaim queue locks, and its comment becomes wrong.**
  `stuck-lock-sweeper.ts:79-83` skips `_private_job_queues` and warns that clearing it
  "would defeat the serialization that is the entire reason to have one" — true of the old
  age-based sweeper, false of a liveness-gated one. Without this, the first crash after
  adopting named queues leaves a queue locked and everything in it unrunnable for four hours
  (graphile's hardcoded `resetLockedAt`). Add to `sweepOnce()`, gated on the same evidence,
  correlated over the queue's own jobs:

  ```sql
  UPDATE graphile_worker._private_job_queues q
     SET locked_at = NULL, locked_by = NULL
   WHERE q.locked_at IS NOT NULL
     AND q.locked_at < now() - ${LOCK_ACQUIRE_GRACE}::interval
     AND NOT EXISTS (SELECT 1 FROM graphile_worker._private_jobs j
                      WHERE j.job_queue_id = q.id AND j.locked_at IS NOT NULL
                        AND ${jobLockHeldExpr})
  RETURNING q.queue_name
  ```

Useful side effect: a wedged serialized job then shows as **ready backlog** (already
attributed per `jobName`) rather than invisible slot exhaustion. Backlog is diagnosable.

### Phase 2 — a declared execution budget on every job

`DefineJobSpec` gains a **required** `budget`, a union rather than a number so the choice is
deliberate — mirroring `dedup`, required for the same reason:

```ts
export type JobBudget =
  /** Abort `ctx.signal` after `ms` of wall-clock in ONE dispatch. Bounds the time a run
   *  may HOLD A SLOT, not workflow duration: `ctx.waitFor`/`ctx.sleep` release the slot
   *  and the resume gets a fresh budget. */
  | { readonly ms: number }
  /** Deliberate opt-out carrying its justification as prose, so it cannot be copy-pasted
   *  and `rg "unbounded:"` enumerates every one. Almost always wrong: a job waiting on an
   *  external event wants `ctx.waitFor`, which releases the slot. */
  | { readonly unbounded: string };
```

Not overridable per-enqueue (unlike `maxAttempts`) — otherwise a call site nobody reviews
re-introduces omission. `JobCtx` gains `readonly signal: AbortSignal`.

**Why this is not the banned liveness inference.** The doctrine bans a third-person claim —
"this row has been locked T, so its owner is dead, so I may re-dispatch it" — which a clock
cannot support. A budget is first-person: *I* have been running this handler for T and I am
giving up on it. The process making the claim holds the advisory lock, so it cannot steal
from itself. Everything downstream stays gated on the existing invariant: **the row moves
only when the handler is provably gone.**

**Enforcement** sits *inside* the `withJobLock` closure in `dispatch()` (`worker.ts:249-290`)
— inside, because the lock must be held for the handler's real lifetime including its
overrun. A new `budget.ts` races `job.run(...)` against the deadline and aborts `ctx.signal`
on expiry. If the handler settles — the normal path — that is an ordinary job failure:
reported, slot freed, retried. An overrun that unwinds gets one retry then dead-letters, so a
deterministically-slow handler cannot burn `maxAttempts × budget` of slot time.

Both observed wedges were promises awaiting something that never resolves, not spin loops, so
the event loop is live and `setTimeout` fires normally. Verified at both sites.

Deliberately **not** using graphile's `helpers.abortSignal`: it is a runner-level shutdown
signal, and conflating "the process is going down" with "this job overran" wants opposite
handling.

**Migration:** 61 job names plus `defineRetention`'s forwarded default. Expect *zero* jobs to
need `unbounded`; expose the set via `getUnboundedJobs()` in Debug → Queue so growth is
visible rather than discovered during the next incident.

### Phase 3 — what happens when the handler does not unwind

Unconditional crash-on-zombie has one disqualifying failure mode: **a crash loop.** A
deterministically-wedging handler that something re-enqueues — `render-thumbnail` is driven
by a file watcher, `reap-stale` by cron — gives zombie → crash → boot → re-dispatch → zombie
→ crash. The backend never stays up, which is worse than the outage being fixed.

So: keep the crash, gate it on whether the pool can still make progress.

```
t = budget        abort ctx.signal, report `job-budget-exceeded`.
                  Most handlers unwind here → normal failure → retry.

t = budget + 30s  zombie confirmed. FORFEIT the slot:
                  · do NOT touch the job row. Its advisory lock is still held by the
                    live zombie, so the sweeper provably will not reclaim it — no
                    double-run, by the existing invariant, with no new concept.
                  · register the slot forfeited; report `job-zombie` → bell, from the
                    dispatch path, NOT from a monitor (the monitor is a job).
                  · `queryRunningJobs()` gains `forfeited: true` so Debug → Queue
                    distinguishes "running" from "written off".

< 2 usable slots  the lane can no longer do its job. Write the report SYNCHRONOUSLY to
left in a lane    disk, then exit(1). Postgres drops every advisory lock at teardown;
                  the next boot's sweeper reclaims cleanly.

anti-loop latch   three floor-crashes within an hour suppresses the fourth. An automatic
tripped           restart that fixes nothing is worse than an honest wedge.
```

The floor is 2, not 1: with a single slot one legitimately long job blocks every monitor —
indistinguishable from the outage being fixed.

This cannot itself loop, because Phase 1 guarantees a *recurring* zombie of one type costs
exactly one slot forever — every later job of that type is blocked at fetch by the queue lock
the zombie's row still holds. Only three genuinely distinct broken handlers reach the floor,
and if three distinct handlers are wedged, restarting is right.

The latch is the one duration in the design. Its comment must say explicitly that it governs
*our own restart policy* and makes no claim about whether any worker is alive — a reviewer
will otherwise pattern-match it onto the banned lease.

`jobs` cannot import `reports` (the same cycle as above), so the crash path needs a
synchronous companion to the hook in `server-core/core/error-reporter.ts` —
`setFatalReporter` / `reportServerFatalSync` — which `reports` implements with its existing
`appendReportSync` buffer, already replayed on next boot. No new persistence.

**Forfeit is not containment without Phase 4.** A forfeited `reap-stale` keeps its host-wide
`worktree-mutate` flock and every backend on the box stays exposed. Phase 4 ships with this,
or the gap is stated out loud in the commit.

### Phase 4 — make the unbounded wait hard to write

- **Delete the `plugins/**/server/**` exemption in `spawn/lint/index.ts:36`, and make a
  bound required on `spawnCaptured`.** Both wedges are child processes.
  `removeWorktreeUnlogged` (`worktree.ts:210-222`) is `Bun.spawn(…, { stdout: "pipe" })` then
  `await proc.exited` — the *exact* bun 1.3.13 exit-during-stream-pull shape the spawn plugin
  exists to eliminate, inside a host-wide flock, exempted by that glob. ~30 server files.
  Note in the commit that **the gate for this has flipped**: `spawn/CLAUDE.md` sets the
  criterion as "the absence of an observed field wedge… diagnosed by hand", and we have now
  observed one twice over.

  ```ts
  export type SpawnOptions = SpawnBaseOptions &
    ( { timeoutMs: number; signal?: AbortSignal }
    | { signal: AbortSignal; timeoutMs?: number }
    | { unbounded: string } );   // prose justification; greppable
  ```

  The third arm is for the CLI, where a 10-minute `./equin build` owns no deadline.
  `signal` needs real implementation: on abort, the SIGTERM → grace → SIGKILL escalation the
  `timeoutMs` path already runs.
- **Host-pool acquire takes an optional `signal`** (`AcquireHooks`, through
  `defineHostPool.run`), with two effects: abort a *pending* acquire, and release the share on
  abort even while `fn` is pending (`HostShare.release()` is already idempotent). Thread
  `ctx.signal` through `withWorktreeMutateSlot`. **This is what makes forfeit real.**
- **`createSemaphore` gets an optional `signal`** — low priority, not required. Its consumers
  are request-scoped leases, and the motivating case evaporates since Phase 1 deletes
  `renderGate`.
- **Not worth doing:** a lint rule banning un-signalled `await` inside a `run` body.
  Unenforceable, huge false-positive rate, and the primitives above cover every real
  forever-wait here.

### Phase 5 — lanes

A budget bounds one job; it does not stop four legitimately slow jobs from filling the pool.
graphile's `get_job` partitions exactly on task id (`getJob.js:127`:
`task_id = any($2::int[])`), so **one `run()` per lane with its own task identifier is a hard
reservation** — a background row is not deprioritized, it is invisible to the control runner.
`runner.js:92-94` confirms `runCron` and `runTaskListInternal` are independent, so one runner
can own every cron item while inserting rows carrying other runners' identifiers. Priority
alone only reorders *pick* time, never *hold* time, which is the entire incident.

Four lanes, because the axis is *(who is blocked) × (duration class)* and both halves matter —
a lane's budget only means something if everything in it releases on the same timescale:

| lane | slots | slot-hog | contents |
|---|---|---|---|
| `control` | 3 | 60s | `events.dispatch`, `jobs.resume`, task/push ingest, `workflows.run` |
| `launch` | 2 | 15m | `database.fork`, `conversations.spawn`, `build.*` |
| `background` | 3 | 5m | everything else — mail, pages, prototypes, backup, worktree-cleanup, retention |
| `monitor` | 1 | 30s | the `debug.*` monitors, `jobs.dead-gc` |

`launch: 2` matches the `db-fork` host pool exactly — more queue slots than the host gate
admits is fiction. `events.dispatch` is a pure router (resolve → validate → `target.enqueue`),
so *routing* is control-lane while *execution* lands in the target's own lane; that is the
property that makes the whole thing work, and why 288 queued dispatch rows were the real
damage.

`lane: JobLane` is required (rung 2). Required alone doesn't stop someone typing
`lane: "control"` on a thumbnail renderer, so three mechanisms keep it honest: a
`job-lanes-declared` check with control/launch/monitor membership in one reviewed file (the
`host-pools-declared` pattern, including "an entry with no live call site also fails"); a
loud assert at `register()` when a job's `slowThresholdMs` exceeds its lane's `slotHogMs`;
and the runtime itself, since the per-lane slot-hog threshold makes a lie about duration
class file a report naming the offender within one tick.

Two couplings must move with it:

- **`job-lock.ts:57`** sizes its pg `Pool` `max: JOB_CONCURRENCY`. Every in-flight job across
  every lane holds one for the whole handler, so it must be `TOTAL_JOB_SLOTS`. At 4 while 9
  slots exist, five handlers would block inside `withJobLock`'s `pool.connect()` *while
  already holding graphile slots* — a brand-new wedge with no symptom. To make that
  undriftable, **delete the `JOB_CONCURRENCY` export entirely**; sizing by "the old single
  number" then has no spelling.
- **`summary-endpoint.ts:25`** becomes per-lane; the summary schema gains a `lanes[]` array
  with the all-lanes rollup retained so existing consumers keep parsing. The
  `get_queue_health` MCP description ("a single shared pool… all jobs route through one
  `jobs.run` task") becomes false and must be rewritten.

`rg -n JOB_TASK` gives the full blast radius: `constants.ts`, `registry.ts` ×2, `worker.ts`
×3, `resume-job.ts`, `introspection.ts` (`jobTaskScope` → `ANY(ALL_JOB_TASKS)`, plus a
`jobLaneExpr` CASE built from the lane table so it cannot drift), `resources.ts` (+ `lane`
optional on `JobRowSchema` so older live-state payloads still parse).

**Migration is the risky part.** Changing the task identifier orphans every already-queued
row. Two mechanisms, both needed: a `repointLaneTasks()` run in `startWorker()` before
`run()`, which inserts the lane identifiers and re-points every *unlocked* row to its
jobName's current lane task (written as a standing invariant — *on every boot a pending row
sits on its job's current lane task* — so future reassignment is safe by construction, not
just this deploy); and keeping `LEGACY_JOB_TASK` in the control runner's taskList for rows
locked during the sweep. No drizzle migration — `_private_jobs` is graphile's.

### The two culprit jobs

- `thumbnails`: `serial: true`, delete `renderGate` and the `createSemaphore` import, bound
  `browser.close()`, explicit timeouts on `newContext`/`newPage`/`screenshot`. The `## Bounds`
  section of its CLAUDE.md needs rewriting.
- `worktree-cleanup` + `infra/worktree`: a timeout on every git subprocess, and never hold a
  `worktree-mutate` slot across an unbounded await.

### The rule worth extracting

Into `jobs/CLAUDE.md` and the `debug` skill:

> A monitor runs exactly one level below the subsystem it watches, and no lower.
> Queue wedged → an interval on the same event loop. Event loop wedged → a worker thread
> (sentinel). Process dead → launchd (`sidequests/monitors`). Going lower buys isolation you
> don't need and pays for it in access to config, the reports engine, and the DB — the things
> that make a report actionable.

Enforced at rung 3, not documented again: add `offQueue?: boolean` to `ReportKindSpec` (beside
the existing `duressExempt` — "this kind describes the job queue" is a property of the kind,
visible at its declaration), and a `monitors-off-subsystem` check built like
`durable-signals-accounted`. The teeth: **any plugin declaring an off-queue kind must contain
zero `defineJob(` call sites in its subtree**, plus "every off-queue kind has a live
`recordReport` call site" so deleting the watchdog fails the build. Rung 1 is unreachable (it
would mean deleting `ScheduleSpec`); rung 2 was considered and rejected — splitting
`recordReport` on a property four kinds have still needs the check, since an author can import
the off-queue function into a job file.

---

## Ordering

1. **Phase 0 — watchdog + cron dedup.** Small, independent, and what makes every later phase
   observed while it lands.
2. **Phase 1 — serialize + delete `renderGate`.** No API break; alone it makes this incident
   cost one slot instead of four.
3. **`ctx.signal` on `JobCtx`.** Purely additive, nothing consumes it yet.
4. **Phase 2 — the budget field.** The churn commit: 61 jobs + `defineRetention`; tsc
   enumerates them and a partial migration is not expressible.
5. **Phase 3 + Phase 4 together.** Forfeit/floor/crash/latch, and the signal plumbing that
   makes forfeit real containment.
6. **Phase 5a — lane metadata only.** `lanes.ts`, the required field, the ~60 assignments,
   with `laneTask()` still returning the legacy identifier. Zero runtime change; the 60-file
   churn lands separately from the risky part.
7. **Phase 5b — the lane runtime**, then lane-aware reporting, then the two checks.

Every step ends with `./equin build` — the registry and plugin docs regenerate, and
`plugins-doc-in-sync` fails otherwise.

## Verification

- A deliberate over-budget job that honours `ctx.signal`: fails cleanly, slot freed, retried,
  one report filed.
- A deliberate over-budget job that ignores it: forfeited; its row stays
  `locked_at IS NOT NULL` with `alive: true`, and a forced `UNSAFE_sweepStuckLocks()` does
  **not** reclaim it. This is the no-steal half and the assertion that matters most.
- Serialization: enqueue N jobs sharing a `serial` key; assert via `query_db` that at most one
  is locked and the others stay `locked_at IS NULL` — i.e. slots stay free for other work.
- Cron dedup: stop the worker, let a per-minute schedule tick several times, assert exactly one
  pending row **and** that its `run_at` has not moved (the `preserve_run_at` property).
- Watchdog: hold every slot past the threshold; assert a report lands in Debug → Reports and
  rings the bell **while the queue is still saturated** — and again with the duress latch set,
  to prove `duressExempt` works.
- Thumbnails end-to-end: save one prototype three times in a burst; one render runs, the card
  updates, no slot held afterwards.

New endpoint `POST /api/events-test/budget-overrun` beside the existing
`crash-recovery` harness, which already exercises both halves of the liveness contract and is
the right home for these.

## Risks to watch after deploy

1. **Total slots 4 → 9.** `JOB_CONCURRENCY` was never the CPU budget — host-admission's pools
   are — and job subprocesses are already darwinbg-demoted. Watch loadavg and the sentinel's
   onset detector for a week.
2. **Connections.** Four graphile pools plus a 9-slot lock pool per backend against a shared
   `max_connections = 500` and ~16 live backends. Set `maxPoolSize` explicitly per runner
   (the default is 10) and verify with `pg_stat_activity` after deploy.
3. **Overlapping cron runs** collapse the orphaned row's retry budget — watch `queue-dead-job`
   for `mail.sync-tick` and `backup.run` on day 1.
4. **The watchdog rides the same event loop.** A wedged loop silences it. That is the
   documented escalation to the sentinel worker thread, deliberately not built now.
