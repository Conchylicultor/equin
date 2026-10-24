# Background activity catalog

Mockup: `proto-1790725097-0w5m` (Prototypes gallery — "Background activity").

## Context

Reviewing the IP-country DB ("downloads the current month, refreshes weekly, neither
pinned nor sha-checked") raised the question: **what does the app run on its own,
and does the human know?** Today nobody can answer it without grepping.

Inventory (non-test call sites, 2026-09-30):

| Mechanism | Real sites | Underneath |
|---|---|---|
| `defineJob` | ~70 (≈40 with `schedule.cron`, ~12 `perWorktree`) | graphile queue |
| `defineSupervisedJob` | 9 | wraps `defineJob` + detached child |
| `defineRetention` | 14 | wraps `defineJob` (nightly cron) |
| `defineWarmup` | 9 | own registry, drained once after boot |
| `defineCorpusIndex` | 1 | file watcher + lazy rebuild (via `defineWarmup`) |
| `defineAssetMirror` | 2 | lazy per-request download — not background |
| raw `setInterval` (server/central) | 3 real loops (conversations poller, turn-emitter, central auth refresh) + ~9 out-of-queue watchdogs/samplers | nothing |
| `createFileWatcher` | 15 | reactive, not autonomous |
| long-lived children | sentinel worker, paging-probe | nothing |

Gaps: no job carries a human description (`_doc` = `{label: name}` only); there is no
list of *registered* jobs anywhere (Debug → Queue shows queue rows only); a
successful run leaves **no record** (graphile deletes the row; only `dead_jobs` and
`supervised_job_runs` persist); no "next run"; nothing says what a job touches.

The primitives are not duplicated execution engines — each earns its runtime shape
(durable queue vs. per-process best-effort vs. per-request). The duplication is in
**declaration**: separate registries, no shared description. So we unify the
declaration and the catalog, not the engines.

Decisions from the user: page lives in the **Debug app**; **Pause is deferred**.

## Design

### 1. New plugin `plugins/infra/plugins/background/` (umbrella) → `catalog` child

- `core/`: types only — `BackgroundEntry` (`kind`, `name`, `description`,
  `trigger` (discriminated: `cron{expr, words, next}` | `event{names}` | `boot` |
  `interval{everyMs}` | `on-demand`), `scope` (`main` | `every-worktree` | `central`),
  `declaredIn` (plugin id), `lastRun?`, `canRunNow`) and the `background.catalog`
  `liveValue` (`source: "external"`, bounded by the declared set — deps precedent,
  `plugins/infra/plugins/deps/server/internal/live.ts:35`).
- `server/`: `defineBackgroundKind({ kind, label, list(): BackgroundEntry[], runNow?(name) })`
  — a registry of *providers*. The catalog merges providers and names no contributor
  (collection-consumer separation). `POST /api/background/run-now {kind, name}`
  dispatches to the owning provider.
- `central/`: the same provider registry + a central `serveValue` (`origin: "central"`)
  for central-runtime entries.
- Contribution `BackgroundTriggerSource` — `(kind, name) → trigger annotation`, so
  `events` can say "Runs when `tasks.created` fires" without `jobs` knowing events
  (events already depends on jobs; `events/server/internal/trigger-contributions.ts:14`).

Import direction: `jobs`, `warmup`, `corpus-index` → `background/catalog/{core,server}`;
catalog imports only framework + `network/live`. No cycle.

### 2. Required description, derived everything else (fix-ladder rung 1 + 2)

- `DefineJobSpec` gains required `description: string` (one present-tense sentence,
  user-facing). Stored on `RegisteredJob` and written to `_doc.detail` so the
  existing registrations facet (`plugin-meta/plugins/facets/plugins/registrations/facet/index.ts:36-46`)
  puts it in the generated plugin docs for free.
- **Derived, never authored:** trigger/schedule (from `schedule`), scope (from
  `perWorktree`), `spawns` (supervised ⇒ true).
- `defineRetention` **derives** its description (`Deletes <table> rows older than N days`)
  — no author input. `defineSupervisedJob` requires `description` and forwards it.
  Neither registers its own kind: their jobs are already in `jobRegistry`, so they
  appear once, as jobs, tagged by factory (`_factory`) for grouping.
- `defineWarmup`, `defineCorpusIndex` require `description`.
- `defineAssetMirror` is request-driven, not background → out of the catalog (its
  host shows up later via observed touches, §5).
- One sweep writes the ~90 sentences; the field lands required in the same change
  (no temporary optional/allowlist).

### 3. Jobs provider + run stats

- Export a `listRegisteredJobs()` from the jobs server barrel (today only
  `getAllRegisteredJobNames`; `getScheduledJobs` at `registry.ts:789` is unexported).
- **Run stats, bounded by construction** (no retention → no jobs↔retention cycle):
  table `job_run_stats`, one row per job name, UPSERT `last_started_at`,
  `last_finished_at`, `last_outcome`, `last_error`, `last_duration_ms`,
  `last_success_at`, `runs`, `failures`; plus `job_recent_runs` as a fixed ring
  (`(job_name, slot = seq % 20)` UPSERT). Written from graphile's
  `job:complete`/`job:failed` events on the per-runner emitters — the same hook the
  slot ledger uses and for the same ordering reason (`slot-ledger.ts:15-21`), not a
  `finally` in `dispatch()`. Internal plumbing jobs (`events.dispatch`, `jobs.resume`)
  are tagged `internal` and collapsed in the UI.
- Next run + words: derive from graphile's own parsed crontab (`parseCronItem`
  output, `worker.ts:158`) so the page can never disagree with the scheduler; a
  resolver returning null renders "Disabled by config". In a worktree, main-only
  jobs render "Runs on main" rather than a stale last run.
- `runNow` only for scheduled jobs (their input is guaranteed to parse `{}`); hidden
  otherwise. Label which backend it runs in.
- Live-state churn: per-minute monitors bump the stats every minute — coalesce the
  catalog value (notify at most every few seconds) and check with live-state-churn.

### 4. `defineTimer` for the setIntervals that must stay out of the queue

- `defineTimer({ name, description, everyMs, run, unref? })` in
  `background/plugins/timer` (kind `timer`, `runTracked`-wrapped, in-memory
  last-tick/duration/error stats, provider for the catalog). Works in central.
- **Not a polling escape hatch** (CLAUDE.md "no polling"): its use is restricted by
  lint to (a) central (no job queue) and (b) out-of-queue watchdogs/samplers, each
  listed in the rule's `ignores` with a reason (pattern:
  `lint/plugins/marker-scan-safety/lint/index.ts`).
- Tighten `detached-work-safety/no-untracked-detached-work`: raw `setInterval` in
  server/central is banned outright (today a `runTracked` callback passes); the only
  implementation site is `defineTimer`.
- Migrate: auth central refresh → `defineTimer`; stuck-lock-sweeper, queue-health
  and stuck-spans watchdogs, health-monitor samplers → `defineTimer`. The
  conversations poller / turn-emitter are real polling: migrate to `defineTimer`
  now (so they're visible) and file a task to replace them with a push signal.
- Out-of-process entries (sentinel worker, paging-probe child, the bin orphan
  guards) stay as-is; covered in Phase 3.

### 5. Page — Debug app

- `background/catalog/web`: pane + `DebugApp.Sidebar` entry "Background activity".
- DataView (`views={["list"]}`), grouped by kind (Scheduled / On event / After boot /
  Cleanup / Timers), search, filters (kind, failed, main vs worktree). Row: status
  dot, description + code name, trigger in words + next run, last run. Detail pane:
  description, trigger, scope, declared-in plugin, recent runs, Run now. No summary
  tiles (per mockup review).
- Worktree and central halves load separately — each renders its own pending state,
  never an empty list.

### Phases

1. Catalog plugin + jobs provider (incl. retention, supervised) + required
   `description` sweep + run stats + page. *This alone answers the original question.*
2. `defineTimer`, lint tightening, warmup/corpus providers, events trigger annotation.
3. **Observed touches** (replaces a declared `touches` field, which nothing would
   check): `safe-fetch` and `infra/spawn` record host / spawn into the ambient run
   context (`runTracked` / job ctx); stats store the set seen in the last 30 days;
   page shows "Contacted: download.db-ip.com". Background code using bare `fetch`
   is migrated to `safeFetch` (lint). Then long-lived children (sentinel,
   paging-probe) and file watchers as their own kinds (file watchers: done, see
   `research/2026-09-30-infra-file-watchers-in-background-catalog.md`; long-lived
   children: done, see
   `research/2026-10-01-infra-long-lived-processes-in-background-catalog.md`). Pause (config-backed set read
   at the `buildCronItems` seam, `worker.ts:158`) after that.

## Critical files

- `plugins/infra/plugins/jobs/server/internal/registry.ts` — `description`, `listRegisteredJobs`, `_doc.detail`
- `plugins/infra/plugins/jobs/server/internal/worker.ts` — cron parse reuse, stats hook wiring
- `plugins/infra/plugins/jobs/server/internal/slot-ledger.ts` — event-hook precedent
- `plugins/infra/plugins/retention/server/internal/define-retention.ts`, `plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/define-supervised-job.ts`
- `plugins/infra/plugins/warmup/server/internal/registry.ts`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/detached-work-safety/lint/no-untracked-detached-work.ts`
- New: `plugins/infra/plugins/background/{plugins/catalog,plugins/timer}/`

## Verification

- `./equin build` (migration for `job_run_stats` / `job_recent_runs` generated).
- `./equin check` — type-check proves every `defineJob`/warmup has a description;
  eslint proves no raw server/central `setInterval`.
- Unit tests: provider merge, cron → words/next from graphile's parse, ring UPSERT.
  `./equin test plugins/infra/plugins/background plugins/infra/plugins/jobs`.
- E2E script `background/plugins/catalog/e2e/verify.ts`: open the pane, assert
  `ip-country.refresh` row shows "Mondays 03:40 UTC", click Run now on a cheap
  scheduled job, assert its last-run updates live.
- `query_db`: `select * from job_run_stats order by last_finished_at desc` after a
  few minutes; row count ≤ registered jobs.
