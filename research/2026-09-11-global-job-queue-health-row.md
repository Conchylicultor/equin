# Job queue row in the unified health report

## Context

The health dot in the tab bar (`shell/health-report`, design
`research/2026-09-10-global-unified-health-report.md`) merges rows that plugins
contribute. Today there are two rows, Worktree and Connection. Nothing tells a human
whether the background job queue is saturated, starving, or holding stuck or dead
jobs, and the dot never turns amber or red because of it.

The Background Jobs page (`block-0500db89-…`, section "In the unified health
report") asks for three things:

- a visual of how full the queue is, per hold class;
- a way to expand it and see the jobs that explain its state;
- ideally, waiting-time statistics.

The mock is `proto-1789050533-m1tj`, sections 3 and 4. This plan adds that row.

### What the code offers today (and what it doesn't)

- **Nothing pushes queue state.** Graphile's tables live outside the change feed.
  `jobsListResource` re-reads up to 500 rows **every 3 s** while someone is
  subscribed. The parent doc's claim that the queue data is "push-based already"
  (`…unified-health-report.md:239-240`) is wrong.
- **No database record says which worker tier holds a running job.** The three
  runners share one job table. `debug/queue-health` calls "is the seconds tier
  full" unanswerable.
- **Waiting time is recorded nowhere.** Graphile deletes a completed row. The
  runtime profiler measures time spent waiting *inside* a handler, not the time a
  job waited to be picked up.
- **But every signal we need exists in-process.**
  - Our graphile runners emit `job:start` / `job:complete` / `worker:fatalError`,
    each carrying the job row and the worker.
  - `add_job` sends `pg_notify('jobs:insert')` on commit.
  - We create each runner ourselves, so a per-runner event emitter knows which tier
    a job occupies.

### Decisions taken with the user

| Topic | Decision |
|---|---|
| Fill bars | **Per-class reach.** Three bars. Each shows how many of the slots that class can use are busy. "minutes 4/4" means a new build or DB fork would wait. The bars share slots, so their numerators can add up past 8. |
| Dead jobs | Amber for **1 hour** after a job dies (config field). Listed in the detail for 24 h. Older ones remain in the bell and Debug → Reports. |
| Waiting thresholds | **Derived ladder.** One new number per class, the *pickup target*: instant 1 s, seconds 10 s, minutes 1 min. Amber at 10× the target. Red at the class's existing deadline. |

### Answers to the page's open questions

- **Which jobs to reveal.** Only the jobs that explain the colour: dead, waiting
  past threshold, stuck. Then "+ N more running · Open queue". When the row is green,
  it lists what is running (at most 8 rows, the slot count). This is the mock's rule.
- **Can this be done without hurting performance?** Yes, and it costs less than today:
  - Slot occupancy comes from memory, with zero queries.
  - The only database read is one aggregate over a table that is normally empty (0
    rows on main right now). It runs only after something changed, at most once per
    second.
  - The payload is under 4 KB and pushed once per change.
  - The same activity signal replaces `jobs-list`'s 3 s timer, so the Debug → Queue
    pane stops polling too.
- **Good waiting-time targets.** See the ladder below. The prior art is GitLab's
  Sidekiq urgency SLOs, already cited in the hold-class design: high urgency gets a
  10 s queueing target, low urgency 1 min. Our `instant` class is stricter (1 s),
  because it has reserved slots and a measured expected wait of about 17 ms.

## UI

Row: `HealthReport.Row({ kind: "status", id: "job-queue", title: "Job queue", order: 20, … })`.

- **Summary (`useStatus`).** One line, worst cause first, at most two causes joined
  by " · ". Examples:
  - "3 running · nothing waiting"
  - "Idle"
  - "Minutes class full · 2 jobs waiting 10m+"
  - "backup.run stuck 35m+"
  - "worktree.fork-db failed ×3"

  Ages are phrased **by the threshold crossed** ("10m+"), never as a live count.
  That way the text stays true between pushes.
- **Glance (always visible while the report is open).** Three segmented bars,
  instant / seconds / minutes. Each has one segment per slot the class can reach
  (8 / 6 / 4). A segment is filled when its slot is busy, hatched when the slot is
  forfeited (written off by a stuck job), and plain otherwise. The number reads
  `busy/reachable`. A bar tints amber or red when its class is what coloured the row.
  The glance holds no controls.
- **Detail (expand).** Only the jobs that explain the colour: dead groups (a red
  dot, "failed ×3", time of death), waiting jobs (an amber dot, class tag, "waiting
  4m"), and stuck running jobs. Then "+ N more running". When the row is green, it
  lists the running jobs with how long each has run. The detail ends with one
  stats line per class:
  "picked up in p50 12 ms · p95 80 ms · max 1.2 s (last 15 min, target 1 s)",
  in amber text when p95 is over the target. The stats never colour the dot: they
  describe the past, and the dot describes now.
- **Action.** "Open queue" opens Debug → Queue.
- **Unknown states.**
  - Server socket not open → grey dot, "Unknown while disconnected".
  - Still loading → grey pulsing dot, "Checking…".
  - Load error → grey dot, "Could not read the queue".

## The verdict

The server computes it with one pure function, so the colour, the timer and future
agent reads cannot disagree. Per class `c`:

| Threshold | instant | seconds | minutes | Source |
|---|---|---|---|---|
| pickup target (new `HOLD_SPECS.pickupTargetMs`) | 1 s | 10 s | 1 min | new |
| attention = 10 × target | 10 s | 100 s | 10 min | derived |
| critical = `deadlineMsFor(c)` | 60 s | 10 min | 60 min | existing |

A job's **wait** is measured from when it became due (`run_at`) to now, or to when
it was picked up for the stats. A row counts as "waiting for a slot" only if it is
ready **and not queued behind a held serial lane**. Serial lanes wait by design, and
counting them would turn the dot amber for correct behaviour. The detail lists them
separately ("N queued behind serial lanes").

Rules, worst wins:

- **critical**: some class's oldest waiting job has waited ≥ critical(c).
- **attention**, if any of:
  - some class's oldest waiting job has waited ≥ attention(c);
  - a running job has held its slot ≥ `slotHogDeadlineFraction × deadlineMsFor(hold)`.
    This is the same line the `queue-slot-hog` report uses, so the dot and the bell
    agree. Forfeited slots are the extreme case and are labelled "stuck · written off";
  - a job died within `deadJobAttentionMinutes` (a new queue-health config field,
    default 60).
- **ok** otherwise.

`queueVerdict(facts, cfg, now)` returns `{ verdict, nextChangeAt }`.
`nextChangeAt` is the earliest future moment any rule could flip:

- an oldest-waiting job reaching the next threshold;
- a running job reaching the stuck line;
- a dead job aging out of the window;
- the next future `run_at` becoming due while its class is full.

The server arms **one** timer at that moment. So a wedged queue, which produces no
events at all, still turns amber on time. This is a deadline, not a poll.

## Architecture

### A. `infra/jobs`: mechanism only (no thresholds)

1. **New `server/internal/slot-ledger.ts`.**
   - `attachSlotLedger(runnerId, events, { listenInserts })`
     - `job:start` stores an `OccupiedSlot` keyed by `worker.workerId`, since one
       worker is one slot: `{ workerId, runnerId, jobId, jobName, hold, runAt, lockedAt, attempt }`.
       It also appends `lockedAt − runAt` to a per-class pickup-sample ring. Both
       values are database timestamps, so there is no clock skew. The ring keeps 15
       minutes of samples, capped at 1024 per class.
     - `job:complete` and `worker:fatalError` delete the slot's entry. This hooks
       graphile's events and *not* a `finally` around `dispatch()`. `job:complete`
       fires after graphile has written the outcome to the database, so the ledger
       never shows a slot free while its row is still locked.
     - Each of these, plus `jobs:insert` (`pool:listen:notification`, legacy runner
       only), calls `emitQueueActivity()`. Each runner has its own LISTEN client,
       so listening on all three would triple every insert.
   - Exports:
     - `getOccupiedSlots()`
     - `getPickupStats() → per class { count, p50, p95, max }`
     - `onQueueActivity(listener) → unsubscribe`
     - `emitQueueActivity()`
     - `clearSlotLedger()`
   - `slot-ledger.test.ts` (bun) drives it with a fake emitter.
2. **`worker.ts` `startWorkers`** (`:281-336`). Create one `EventEmitter` per runner
   and attach it **before** `run()`, passed as `run({ events, … })`. Jobs can start
   inside `run()`, so attaching afterwards would miss them. `stopWorkers` calls
   `clearSlotLedger()`: a graceful shutdown releases jobs without `job:complete`.
3. **Queue changes that send no notification** call `emitQueueActivity()`:
   - cancel and retry (`handle.ts`)
   - `abort-run.ts`
   - the resume-cancel DELETE in `resume-job.ts`
   - the stuck-lock sweeper reclaim
   - `dead-job-gc.ts`
4. **`introspection.ts`** stays the single owner of the coupling to graphile's
   internal tables. Add:
   - `queryQueuePulse()`: one aggregate per class covering waiting-for-slot count
     (excluding rows whose `_private_job_queues.locked_at` is set), oldest waiting
     `run_at`, rows behind a held lane, locked count, and next future `run_at`.
   - `queryOldestWaiting(limit = 5)`: `{ jobId, jobName, hold, runAt, attempts }`.
   - `queryRecentDeadJobs({ since, limit = 5 })`: live dead rows plus the `dead_jobs`
     archive, grouped by job name, as `{ jobName, count, lastDiedAt, lastError (truncated) }`.
     If the plan shows a scan, add an index on `dead_jobs.died_at`.
5. **`resources.ts`.** Delete `jobsListResource`'s `setInterval`. Its subscribe hooks
   register `onQueueActivity(() => jobsListResource.notify())` instead, and it gets
   `debounceMs: 1000`, the runtime's existing trailing debounce.
6. **`core/hold.ts`.** Add `pickupTargetMs` to `HoldClassSpec` and `HOLD_SPECS`
   (1 000 / 10 000 / 60 000), plus a `pickupTargetMsFor(hold)` helper. It is a
   sibling of `ceilingMs`, and like `ceilingMs` it is read only by queue-health.
7. **Barrel and `jobs/CLAUDE.md`.**
   - Export `getOccupiedSlots`, `getPickupStats`, `onQueueActivity`, `OccupiedSlot`
     and the three new queries.
   - Add a short "slot ledger" section. Its point: the ledger is the only exact
     answer to "which tier holds this job", and it hooks graphile's events rather
     than the handler, for the reason above.

### B. `debug/queue-health`: interpretation, resource, row

Stays here: this plugin owns queue thresholds and config, and it already imports
`jobs`. It adds one new plugin edge, `→ shell/health-report/web`, which has no
cycle. The web half is eager by structure (it isn't under `apps/`).

8. **New `core/pulse.ts`.**
   - `QueuePulseSchema`, with `.max()` on every array so the size bound is a fact:
     - `classes[3]`: `{ hold, reachable, usable, busy, forfeited, waiting, oldestWaitingRunAt, behindLanes, pickup: {count,p50,p95,max} }`
     - `running` (≤ `TOTAL_JOB_SLOTS`): `{ jobId, jobName, hold, runnerId, lockedAt, stuck, forfeited }`
     - `oldestWaiting` (≤ 5)
     - `dead` (≤ 5)
     - `orphanLocked`: rows locked in the DB but absent from the ledger, i.e. held by
       a dead worker the sweeper will reclaim. Clamped to ≥ 0.
     - `verdict: { state, summary, cause: per-class tone }`
   - `queuePulseResource = resourceDescriptor("queue-health.pulse", …)`, not
     `bootCritical`. The Connection row is still connecting at first paint anyway,
     and a boot-critical resource would add DB reads to every page load.
9. **New `core/verdict.ts` and `verdict.test.ts` (bun).** `queueVerdict` as specified
   above. Pure: it takes facts, thresholds, config and `now`.
10. **`core/config.ts`.** Add `deadJobAttentionMinutes` (int, default 60, min 0;
    0 means dead jobs never colour).
11. **New `server/internal/pulse.ts`.**
    - The loader takes `getOccupiedSlots()`, `getForfeitedSlots()`,
      `getPickupStats()`, the three queries and `getConfig`, then runs
      `queueVerdict`.
    - `defineExternalResource(queuePulseResource, { mode: "push", debounceMs: 1000, … })`.
    - `onFirstSubscribe` registers the activity listener. Each load re-arms the
      single `nextChangeAt` timer, clamped to setTimeout's maximum.
      `onLastUnsubscribe` clears both.
    - The `dead_jobs` table is picked up by the change feed automatically, because
      the loader reads it.
    - Register it with `Resource.Declare` in `server/index.ts`.
12. **Web.**
    - `web/internal/use-queue-health.ts`: `useStatus`. It maps a closed socket
      (from `useNotificationsChannelStatuses`), pending, and error states to
      `unknown`, and otherwise returns `data.verdict`.
    - `web/components/queue-glance.tsx`: the bars. It uses existing layout
      primitives (read the `css` skill first) and no hand-rolled colours.
    - `web/components/queue-detail.tsx`: the explaining-jobs list plus the stats
      lines. It is a bounded list of at most about 10 rows, and the full list is
      Debug → Queue. So it uses `Row` with the `data-view/no-adhoc-row-list`
      disable, as the health-report panel itself does.
    - `web/components/open-queue-action.tsx`: `navigate(queueRoute.link(debugApp, {}))`.
    - `web/internal/use-age-clock.ts`: one `setTimeout` to the next moment a displayed
      age changes, like data-view's `useGroupingClock`. Used only by the glance and
      the detail, never by `useStatus`.
    - `web/index.ts`: the `HealthReport.Row` contribution.
    - Format durations with the plugin's existing `shared/format-duration.ts`.
13. **`debug/queue`.** Move `defineRoute({ id: "queue", segment: "queue" })` to a new
    `core/routes.ts` as `queueRoute`, the same pattern as `reports/core/routes.ts`.
    `web/panes.ts` then uses it.

### C. Framework: stop the false alarm the design would amplify

14. **`resource-runtime/core/runtime.ts:2436-2441`** prints a "read-set-gap
    candidate" warning on every manual notify with no matching change-feed notify.
    For resources declared with `defineExternalResource`, a manual notify is by
    design the only source, so the warning is always false for them. Main's logs
    hold about 269k such lines for `config-v2.values`. Skip the warning when the
    entry is external. That is one condition; add a test beside the runtime's
    existing notify tests.

### D. Docs

15. **`debug/queue-health/CLAUDE.md`.**
    - Add a "Health row and pulse" section: the verdict ladder, the single timer,
      and the serial-lane exclusion.
    - Correct "which runner holds a locked row: unanswerable". It is now answered
      exactly, for this backend, by the ledger.
16. **`research/2026-09-10-global-unified-health-report.md:239-240`.** Correct the
    "push-based already" claim and point to this doc.
17. Plugin reference blocks, registries and `plugins-details.md` regenerate on
    `./equin build`.

## Follow-ups (not in this task)

- **Watchdog.** Have it share the pulse's snapshot builder, not the resource (it must
  run with no tabs open). With the ledger, "wedged" becomes exact per tier, and the
  30 s interval could become a deadline timer plus a slow backstop.
- **Per-class completion counter.** `job:complete` gives one for free. That closes
  `queue-class-starved`'s stated gap about serial-lane heads.
- **`get_queue_health` MCP tool.** Add the verdict, exact per-runner occupancy and
  pickup stats.

## Verification

1. **Tests.**
   ```bash
   ./equin test plugins/infra/plugins/jobs plugins/debug/plugins/queue-health plugins/framework/plugins/resource-runtime
   ```
   - Ledger:
     - start → complete frees the slot;
     - fatalError frees it;
     - per-runner busy counts;
     - `jobs:insert` from the legacy runner only;
     - ring eviction and percentiles.
   - Verdict:
     - each rule, and precedence;
     - serial-lane rows never colour;
     - the summary wording;
     - `nextChangeAt` for each source.
   - jsdom:
     - `useStatus` for disconnected, pending, error and data;
     - the glance renders busy, forfeited and tint correctly;
     - the detail lists only explaining jobs when not ok.
2. **Deploy.** `./equin build` in the background, then check the deploy receipt
   `~/.singularity/worktrees/att-1789119339-tt6y/build-status.json`.
3. **Screenshots, idle.** Open the report and expand the queue row, in light and dark:
   ```bash
   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --click "All systems normal" --out /tmp/qh
   ```
4. **Saturation and dead jobs.** Add an `events-test` harness endpoint,
   `POST /api/events-test/queue-saturate`. It enqueues five 90 s `minutes`-class
   sleeper jobs and one job that always fails with `NonRetryableError`.
   - Confirm the minutes bar reads 4/4, one sleeper is waiting, and the dot turns
     amber once the wait passes the threshold. To see that without waiting 10
     minutes, the harness takes a `runAt` in the past.
   - Confirm the dead job is listed and colours the dot.
   - Confirm everything returns to green as the jobs drain, with no reload.
   - Capture each state in a screenshot.
5. **Performance.**
   - `get_runtime_profile(kind: "loader")` shows the `queue-health.pulse` loader in
     the low single-digit milliseconds, at most one load per second under the
     saturation harness.
   - `jobs-list` shows no loads while Debug → Queue is closed.
   - No new `read-set-gap` lines appear in the gateway log.
6. **Checks.** `./equin check`. This covers plugin boundaries (no cycle),
   `no-db-backed-notify`, `jobs:no-raw-addjob`, `eager-tier-in-sync`, the registry
   and doc sync checks, and type-check/lint.
