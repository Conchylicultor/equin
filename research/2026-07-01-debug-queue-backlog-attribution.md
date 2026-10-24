# Job-queue backlog/saturation attribution

**Date:** 2026-07-01
**Category:** debug (observability over the `infra/jobs` graphile queue)

## Context

The graphile-worker job queue (shared 4-slot pool; every job routes through the
single `jobs.run` task with its real name in `payload->>'jobName'`) backs up
regularly on `singularity` — the `queue-backlog` report recurs (observed count
545). But when it backs up, an operator/agent **cannot tell which jobs are
responsible**:

- `queue-backlog` (`debug/queue-health`) is **aggregate-only**: `readyCount` /
  `lockedCount` / `oldestOverdueMs`, no per-jobName breakdown of what is filling
  the ready queue.
- **Slot-hogging is invisible**: the `stalled` signal only trips when
  `lockedCount === 0`. A job locked and actively running for many minutes
  (observed: ~11 min while a new conversation waited on its own queued
  `queue.seed-rank`) produces **no report at all**.
- **No debug MCP tool** for queue health. Diagnosis required hand-written SQL
  against graphile internals (`_private_jobs`, decoding `payload->>'jobName'`) —
  exactly the coupling the jobs introspection API exists to hide.

Goal: surface the queue's saturation modes **loudly** (reports + a debug MCP
surface) **with attribution** — which jobs dominate the ready backlog, and which
jobs hold the shared slots the longest.

### Decisions (confirmed with user)

- **Backlog attribution: enrich the existing `queue-backlog` rollup** (one
  rolling report per worktree) with a top-N per-jobName breakdown — not a
  separate per-job report kind. Preserves the "queue is backed up" gestalt and
  the ranked-in-one-place view; no report proliferation.
- **Reports + MCP only** — the live `Debug → Queue` pane is left unchanged.
- **Slow-job history is a follow-up** (see below). This change introspects
  *existing* graphile state only; it does not instrument the worker hot path.

### What this covers (job-queue failure/saturation taxonomy)

| Mode | Coverage after this change |
|---|---|
| Terminal failures (dead jobs) | Already exists — `queue-dead-job`, per-jobName |
| Backlog depth / stall (0 running, overdue) | Exists — `queue-backlog`; **+ per-jobName ready breakdown** |
| Slot-hogging (a job holding a slot too long, incl. the `lockedCount>0` wedge) | **NEW** `queue-slot-hog`, per-jobName, from currently-locked duration |
| Oversubscription / contention (all 4 slots busy + backlog growing) | Surfaced via the enriched backlog breakdown + `get_queue_health`'s `lockedCount / concurrency` + live running-job list |

**Out of scope (follow-up task):** durable historical per-jobName execution-time
profiling (instrument the worker dispatcher's `run()`, a per-jobName p50/p95/max
rollup table, and a `queue-slow-job` report). File via `add_task` after this
lands.

## Design

All new queue reads compose the existing graphile-coupling fragments in
`plugins/infra/plugins/jobs/server/internal/introspection.ts` (`jobNameExpr`,
`queueJobsFrom`, `jobTaskScope`) — the single home for that coupling. The MCP
tool follows the `get_runtime_profile` **gateway-proxy** pattern (fetch the
target worktree's own backend) rather than `query_db`'s direct-DB pattern,
because it lets the target backend run the introspection functions against its
own `db` — keeping the graphile coupling in one place and supporting
cross-worktree targeting for free. (The queue lives in each worktree's own DB
fork; the monitor is already `perWorktree`.)

### Task 1 — New introspection queries + expose concurrency (`infra/jobs`)

**File:** `plugins/infra/plugins/jobs/server/internal/introspection.ts`

Add two read-only functions, mirroring `queryDeadJobStats`'s shape (reuse
`jobNameExpr` / `queueJobsFrom` / `jobTaskScope` and the `ready` predicate
fragment already used by `queryQueueBacklog`):

```ts
export interface BacklogJobStat { jobName: string; readyCount: number; oldestOverdueMs: number; }
// GROUP BY jobName over the ready predicate, ORDER BY ready DESC. Used to attribute the rollup.
export async function queryBacklogByJobName(limit = 5): Promise<BacklogJobStat[]>

export interface RunningJobStat { jobName: string; jobId: string; lockedForMs: number; lockedBy: string | null; }
// j.locked_at IS NOT NULL AND jobTaskScope; lockedForMs = now() - j.locked_at; ORDER BY lockedForMs DESC.
export async function queryRunningJobs(): Promise<RunningJobStat[]>
```

**Expose the pool size** (currently a private `const CONCURRENCY = 4` in
`worker.ts`): move it to `internal/constants.ts` as `export const
JOB_CONCURRENCY = 4;` (next to `JOB_TASK`), import it in `worker.ts`. Single
source; lets the summary report `lockedCount / concurrency` saturation.

**File:** `plugins/infra/plugins/jobs/server/index.ts` — re-export
`queryBacklogByJobName`, `queryRunningJobs`, `JOB_CONCURRENCY`, and the two new
types (`BacklogJobStat`, `RunningJobStat`).

### Task 2 — Queue-health summary endpoint (`debug/queue-health`)

A typed HTTP endpoint the MCP tool proxies to (mirrors
`GET /api/debug/profiling/runtime`).

- **File:** `plugins/debug/plugins/queue-health/core/summary.ts` (new) —
  `defineEndpoint` (`infra/endpoints`) `queueHealthSummaryEndpoint`
  (`GET /api/debug/queue-health/summary`, no input) with a
  `QueueHealthSummarySchema` response:
  `{ concurrency, backlog: { readyCount, lockedCount, oldestOverdueMs }, byJobName: BacklogJobStat[], running: RunningJobStat[], dead: DeadJobStat[] }`.
  Export both from `core/index.ts`.
- **File:** `plugins/debug/plugins/queue-health/server/internal/summary-endpoint.ts`
  (new) — `implement(queueHealthSummaryEndpoint, …)` calling
  `queryQueueBacklog()`, `queryBacklogByJobName()`, `queryRunningJobs()`,
  `queryDeadJobStats()`, and `JOB_CONCURRENCY`, all from `@plugins/infra/plugins/jobs/server`.

### Task 3 — `get_queue_health` MCP tool (`debug/queue-health`)

**File:** `plugins/debug/plugins/queue-health/server/internal/mcp-tool.ts` (new).
Copy the `get_runtime_profile` template (`plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`):

- `inputSchema: { worktree: z.string().optional().describe(...) }`.
- Resolve worktree: `worktree` arg else `basename(getConversation(conversationId).worktreePath)`; validate `/^[a-zA-Z0-9_-]+$/`.
- `fetch("http://" + worktreeName + ".localhost:9000/api/debug/queue-health/summary")`, parse with `QueueHealthSummarySchema`, return `JSON.stringify(...)` in a text content block.
- A verbose `description` (the only doc the calling agent sees) explaining: the shared `concurrency`-slot pool, that `byJobName` attributes the ready backlog, `running` (with `lockedForMs`) attributes who holds the slots, and `dead` the terminal failures.

### Task 4 — Enrich the `queue-backlog` report + add `queue-slot-hog` (`debug/queue-health`)

**Enrich backlog** — `core/kinds.ts`: extend `QueueBacklogPayloadSchema` with
`topReady: z.array(z.object({ jobName: z.string(), readyCount: z.number().int(), oldestOverdueMs: z.number().int() })).optional()`
(**optional** — backward-compatible with already-stored reports). The existing
`backlog-kind.ts` `renderTask` and `web/components/backlog-summary.tsx` render
the ranked offenders when present. `monitor-job.ts` `checkBacklog()` calls
`queryBacklogByJobName()` and includes it in the payload when the threshold
trips.

**New `queue-slot-hog` kind** (variant `warning`), one report per hot jobName
(fingerprint `queue-slot-hog:<jobName>`, the `(fingerprint, worktree)`
unique-index trick — mirrors `queue-dead-job`):

- `core/kinds.ts`: `QueueSlotHogPayloadSchema = { jobName, lockedForMs, runningCount, sampleJobId }`. Export schema + type from `core/index.ts`.
- `server/internal/slot-hog-kind.ts` (new) — `ReportKind({ kind: "queue-slot-hog", … })`, copying `dead-job-kind.ts`'s structure (tag `[queue]`, `notifCooldownMs` 600_000).
- `server/internal/monitor-job.ts` — new `checkSlotHogs(runningJobMinutes)`:
  `queryRunningJobs()`, collapse to the longest-locked row per jobName, and
  `recordReport({ kind: "queue-slot-hog", source: "server-queue-monitor", … })`
  for each jobName whose `lockedForMs > runningJobMinutes * 60_000`. Call it from
  `run` alongside `checkDeadJobs` / `checkBacklog`.
- `core/config.ts` — add `runningJobMinutes: intField({ default: 5, min: 0, label: "Slot-hog threshold (minutes)", description: "File a queue-slot-hog report when a job has held a worker slot (locked/running) longer than this many minutes." })`. Rendered in Settings → Config for free via the existing `ConfigV2.Register` / `WebRegister`.
- `web/components/slot-hog-summary.tsx` (new) — `Reports.KindView` for
  `queue-slot-hog`, copying `dead-job-summary.tsx` (mono `Badge` jobName +
  `formatDurationMs(lockedForMs)` from `shared/format-duration.ts`).

### Task 5 — Wire registrations (`debug/queue-health`)

- `server/index.ts` — add the summary endpoint impl and the MCP tool to
  `register: [queueHealthMonitorJob, …]`; add `slotHogKind` to `contributions`.
  (`get_runtime_profile` precedent: both the `implement()` route and the
  `Mcp.tool` live in `register`.)
- `web/index.ts` — add `Reports.KindView({ match: "queue-slot-hog", component: SlotHogSummary })`.
- Update `plugins/debug/plugins/queue-health/CLAUDE.md` prose (new
  `queue-slot-hog` kind, the enriched backlog payload, the `get_queue_health`
  tool + summary endpoint, and the new `runningJobMinutes` threshold).

## Critical files

- `plugins/infra/plugins/jobs/server/internal/introspection.ts` — new queries (single home for graphile coupling)
- `plugins/infra/plugins/jobs/server/internal/{constants,worker}.ts` — `JOB_CONCURRENCY` move
- `plugins/infra/plugins/jobs/server/index.ts` — barrel re-exports
- `plugins/debug/plugins/queue-health/{core,server,web}/…` — endpoint, MCP tool, report kind, config, renderers, registrations
- Templates to copy: `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts` (MCP + gateway-proxy), `plugins/database/plugins/query/server/internal/mcp-tools.ts` (MCP shape), `.../queue-health/server/internal/{dead-job-kind,monitor-job}.ts` (report kind + monitor)

## Verification

1. `./equin build` from the worktree (regenerates the config `.origin.jsonc`, restarts the server, re-runs checks). Then `./equin check` for boundary/lint/type.
2. **MCP tool** — call `get_queue_health` (no args → own worktree; `worktree: "singularity"` → main). Confirm the JSON has `concurrency`, `backlog`, non-empty `byJobName` ranking + `running` with `lockedForMs` when the queue is active, and `dead`.
3. **Backlog attribution** — with `singularity` backed up, confirm the recurring `queue-backlog` report in **Debug → Reports** now shows the top-N per-jobName breakdown in its summary + detail.
4. **Slot-hog** — enqueue/observe a job locked longer than `runningJobMinutes` (temporarily lower the threshold in Settings → Config) with `lockedCount > 0`; confirm a `queue-slot-hog` report fires naming the job — the exact case that produced no report before. Cross-check the live rows via `query_db` against `graphile_worker._private_jobs`.
5. Confirm Settings → Config renders the new `runningJobMinutes` field.
