# Queue-health monitoring: surface dead jobs & queue backlogs as reports

## Context

The graphile-worker job queue degrades **silently** — there is no signal anywhere
in the UI when it breaks. Two distinct failure modes were observed on `main` and
went unnoticed until someone hand-inspected the queue tables:

1. **Dead/failed jobs pile up.** A retry storm of ~589 `[events] unknown job
   "improve.apply-queue-top"` failures, plus `relation "build_runs" does not
   exist`, `relation "improve_pending_queue_top" does not exist`, and `column
   a.status does not exist` errors, accumulated 623 jobs carrying a `last_error`
   (many at `max_attempts`) in `graphile_worker._private_jobs`. None surfaced as a
   report; they just retried and clogged the queue.

2. **The queue backs up / stalls.** Backlog grew to 280+ overdue jobs, oldest
   pending ~70 min, **0 locked** (worker making no progress), while new jobs kept
   being enqueued. A stalled worker looks identical to an idle one — no alert.

Both modes should be **loud**: recorded in the report system (the same surface
that captures crashes), so they can be investigated instead of being invisible
until a human reads the queue tables. This is the **observability gap only** —
fixing the specific `improve.apply-queue-top` binding drift is a separate task.

## Approach

Add a new server-only observability plugin **`plugins/debug/plugins/queue-health/`**,
modeled byte-for-byte on the `plugins/debug/plugins/slow-ops/` precedent (durable
signal → `ReportKind` → deduped task). It runs a cheap scheduled `defineJob` that
samples the queue and files reports through the existing reports engine when
thresholds trip. No changes to the load-bearing `infra/jobs` core.

### Why a separate plugin (not folded into `infra/jobs`)

`infra/jobs` is load-bearing and must not gain reporting/threshold logic. The
monitor only **consumes the public `defineJob` API** and reads the DB read-only.
It sits next to the existing `debug/queue` inspection pane and `debug/slow-ops`
(the precedent for "observability that files reports").

### Signals & thresholds

Two report **kinds**, both fired from one scheduled monitor job per worktree.

**Kind `queue-dead-job`** (variant `error`) — terminally failed jobs.
- Source query: `graphile_worker._private_jobs j JOIN _private_tasks t ON t.id =
  j.task_id WHERE t.identifier = 'jobs.run'`, grouped by `payload->>'jobName'`,
  filtered to `attempts >= max_attempts AND locked_at IS NULL` (the same
  "terminally dead" predicate `reconcileDeadJobs` uses). Querying the live queue
  (not the hourly-GC'd `dead_jobs` archive) avoids a ≤1h reporting delay.
- One report **per distinct `jobName`** (fingerprint = `queue-dead-job:<jobName>`),
  so a retry-storm of one broken job collapses to a single task while distinct
  broken jobs get distinct tasks — exactly the observed scenario (one task for
  `improve.apply-queue-top`, separate ones for the missing-relation jobs).
- `data`: `{ jobName, deadCount, attempts, maxAttempts, lastError, sampleJobId }`.

**Kind `queue-backlog`** (variant `warning`, escalates copy to "stalled") — depth/stall.
- Source query: aggregate over the same table — `readyCount` (run_at <= now AND
  locked_at IS NULL AND attempts < max_attempts), `oldestOverdueMs`
  (`max(now - run_at)` among ready), `lockedCount` (locked_at IS NOT NULL).
- Trips when **either**: `readyCount > backlogDepthThreshold` (overwhelmed), **or**
  `oldestOverdueMs > oldestOverdueMinutes` (stalled/slow). `stalled = lockedCount
  == 0 && oldestOverdueMs > threshold` (worker making no progress) — drives the
  escalated message.
- One rolling report **per worktree** (fingerprint = `queue-backlog:rollup`; the
  reports unique index is `(fingerprint, worktree)`, so worktrees never collide).
- `data`: `{ readyCount, oldestOverdueMs, lockedCount, stalled }`.

Defaults (tunable via config_v2, mirroring `slowOpConfig`):
`backlogDepthThreshold = 200`, `oldestOverdueMinutes = 10`, `enabled = true`.

### Avoiding self-inflicted load

- **One scheduled job**, `dedup: "singleton"`, `schedule: { cron: "*/5 * * * *",
  perWorktree: true }` (every 5 min, each worktree's own DB fork). Singleton dedup
  means the monitor itself can never pile up.
- **Two cheap aggregate queries** per run (no row fetches): one GROUP BY for dead
  jobs, one aggregate for backlog. Both already-indexed predicates the existing
  jobs SQL uses.
- `maxAttempts: 3` on the monitor job so a transiently-broken monitor doesn't
  itself become a dead-job storm.
- `recordReport` only called when a threshold trips (silent when healthy); the
  engine's own velocity limiter (20/60s) + dedup absorb bursts.
- Both kinds set `notifCooldownMs` (~10 min) so a persistent problem re-alerts the
  bell periodically without spamming — same rationale as slow-op's cooldown.

### Files to create

```
plugins/debug/plugins/queue-health/
├── CLAUDE.md                                  # prose + autogen block
├── package.json                               # name @singularity/plugin-debug-queue-health
├── core/
│   ├── index.ts                               # barrel: schemas + config descriptor
│   ├── config.ts                              # queueHealthConfig (defineConfig)
│   └── kinds.ts                               # zod payload schemas for both kinds
├── server/
│   ├── index.ts                               # definePlugin: register monitor job + 2 ReportKind + ConfigV2.Register
│   └── internal/
│       ├── monitor-job.ts                     # defineJob, the two aggregate queries
│       ├── dead-job-kind.ts                   # ReportKind("queue-dead-job") + renderTask
│       └── backlog-kind.ts                    # ReportKind("queue-backlog") + renderTask
└── web/
    ├── index.ts                               # definePlugin: 2 Reports.KindView renderers
    └── components/
        ├── dead-job-summary.tsx               # one-line Reports-pane summary
        └── backlog-summary.tsx
```

### Files to modify

- `plugins/reports/shared/types.ts` — add **one** literal `"server-queue-monitor"`
  to `SERVER_REPORT_SOURCES`. This is additive and follows the exact precedent of
  slow-op adding `server-slow-op`; the source enum is the reports plugin's
  documented per-kind extension point. (Fallback if disallowed: reuse
  `server-caught`, but the dedicated source makes the Reports pane self-documenting.)
- Autogen: `./equin build` regenerates registries + docs (`plugins-*.md`,
  per-plugin autogen blocks). No hand edits to generated files.

### Key reused primitives / references

- `defineJob` + `ScheduleSpec` — `plugins/infra/plugins/jobs/server` (pattern:
  `deadJobGcJob` in `.../internal/dead-job-gc.ts`, scheduled `perWorktree`).
- `recordReport`, `ReportKind`, `ReportRow` — `@plugins/reports/server` (pattern:
  `slowOpKind` in `plugins/debug/plugins/slow-ops/server/internal/slow-op-kind.ts`).
- `Reports.KindView` dispatch slot — `@plugins/reports/web` (pattern: the crash
  kind-view in `plugins/reports/plugins/crash/web`).
- `defineConfig` / `ConfigV2.Register` / `useConfig` — config_v2 (pattern:
  `slowOpConfig`).
- The terminally-dead predicate & graphile table/column shape —
  `plugins/infra/plugins/jobs/server/internal/dead-job-gc.ts` and `resources.ts`.
- `db.execute(sql\`...\`)` — `@plugins/database/server`.

## Verification

1. `./equin build` (regenerates migrations/registries/docs, runs checks).
2. `./equin check` — boundaries, plugins-registry-in-sync, plugins-doc-in-sync,
   type-check all green.
3. Manually trip the monitor (worktree DB, via `query_db` for inspection):
   - **Backlog:** enqueue many far-future-then-due dummy jobs, or temporarily lower
     `oldestOverdueMinutes`/`backlogDepthThreshold` in config and confirm a
     `queue-backlog` report + task appears in **Debug → Reports**.
   - **Dead job:** define a throwaway job whose `run` always throws with low
     `maxAttempts`, enqueue it, let it exhaust attempts, then run the monitor and
     confirm a `queue-dead-job` report keyed by its name appears.
   - Confirm dedup: re-running the monitor bumps `count`, not new tasks.
   - Confirm healthy state files nothing.
4. Confirm the monitor query cost is negligible (two aggregates) via the queue pane /
   `get_runtime_profile`.

## Follow-ups to file

- The specific `improve.apply-queue-top` event→job binding drift (separate task —
  the trigger references a job name that no longer exists).
- Consider a cluster-wide rollup tab (like slow-ops `cluster`) once per-worktree
  reports prove useful.
