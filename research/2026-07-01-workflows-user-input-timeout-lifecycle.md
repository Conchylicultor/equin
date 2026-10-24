# Workflows: bounded lifecycle for suspended `user-input` steps

**Date:** 2026-07-01
**Category:** workflows (touches `infra/jobs` for a generic teardown primitive)

## Context

A workflow `user-input` step suspends its durable run via `ctx.waitFor` on the
`userInputSubmitted` trigger event **with no `timeoutMs`**. If the human never
submits the form, the execution stays in `suspended` status **forever** — no
expiry, escalation, or cancellation path other than a manual delete. As
workflows move toward real human-in-the-loop use, this is a correctness/lifecycle
gap.

Investigation found three distinct problems:

1. **Unbounded wait.** `user-input/server/internal/executor.ts` is the *only*
   `ctx.waitFor` caller in the repo that omits `timeoutMs`. The option already
   exists and works: it schedules a self-cancelling `jobs.resume` racer job that
   resumes the handler with `null` on timeout.
2. **Shallow cancellation.** `cancelExecution` only flips
   `_workflowExecutions.status` to `"failed"`. It leaves the `_jobWaits` row
   `pending`, the `userInputSubmitted` trigger subscription armed, and the
   suspended step row untouched. There is no distinct `cancelled` status.
3. **Silent-resume-after-cancel trap (real today).** `ctx.step("init")` in
   `run-job.ts` is memoized, so its `status === "completed"|"failed"` early-return
   guard is **never re-evaluated on resume**. A late form submit (stale tab) can
   therefore resurrect a cancelled/finished execution and run it to completion.

**Intended outcome:** every `user-input` wait is bounded by a configurable
deadline; on expiry the run lands in a clean terminal `expired` state; manual
cancel produces a clean terminal `cancelled` state and structurally cannot be
resurrected by a late event.

## Design

### 1. Configurable expiry on the `user-input` step (closes the core gap)
- Add optional `expiresAfter: { amount: number; unit: "minutes"|"hours"|"days" }`
  to the user-input step config. Default `DEFAULT_EXPIRES_AFTER = { amount: 7, unit: "days" }`
  when unset. **No "never" option** — every wait is bounded by construction.
- Executor resolves config → `timeoutMs`, writes the deadline once (see below),
  then passes `{ timeoutMs }` to `ctx.waitFor`.
- On `null` return (timeout) the executor **returns `{ expired: true }`** — it does
  *not* throw. (Throwing would be recorded as a step error and trigger graphile
  retries up to `maxAttempts` → retry storm + dead-letter for a normal business
  outcome. The union return is handled in run-job's normal post-exec path.)

### 2. New terminal lifecycle statuses
- Add `cancelled` and `expired` to both `ExecutionStatusSchema` and
  `ExecutionStepStatusSchema`. Status is a `text` column → **no migration**.
- `run-job` handles `result.expired` in the **normal** post-exec path: mark step +
  execution `expired`, set `completedAt`, return. The existing catch keeps mapping
  genuine errors → `failed` (unchanged).

### 3. Clean cancellation teardown + structural trap fix
- **New generic jobs-plugin primitive** `abortDurableRun(workflowRunId)` (the jobs
  plugin owns `_jobWaits` and the resume jobKey conventions). Best-effort,
  idempotent:
  1. `UPDATE _jobWaits SET status='cancelled', resolvedAt=now() WHERE workflow_run_id=? AND status='pending'`
  2. `DELETE FROM graphile_worker._private_jobs WHERE key LIKE 'jobs.resume.timeout:<run>:%' AND locked_at IS NULL`
     (and the same for the `jobs.resume.sleep:<run>:%` prefix) — mirrors
     `resume-job.ts:115-117`.
  3. `DELETE ... WHERE key = '<run>' AND locked_at IS NULL` — clears any
     not-yet-started resume of the main handler.
  - Add `"cancelled"` to the `_jobWaits.status` `$type` union (text → no migration).
  - Because `jobs.resume` no-ops on a non-pending wait row
    (`resume-job.ts:58`), a late event then harmlessly no-ops.
- `cancelExecution` (engine), **status-first ordering**:
  1. In one `db.transaction`: set execution `status='cancelled', completedAt`, and the
     execution's suspended step(s) `status='cancelled', completedAt`.
  2. `await abortDurableRun("workflows.run:" + id)`.
  3. Delete the execution's own `_userInputSubmittedTriggers` rows
     (`WHERE execution_id = id`) — the engine owns that event table, so this stays
     boundary-clean (no reaching into jobs/events internals). Defense-in-depth.
- **Authoritative trap fix:** add a **non-memoized terminal re-check at the top of
  run-job's `while` loop**, *before* the mark-running write:
  ```ts
  const [live] = await db.select({ status: _workflowExecutions.status })
    .from(_workflowExecutions).where(eq(_workflowExecutions.id, input.executionId));
  if (live && (live.status === "cancelled" || live.status === "expired")) return;
  ```
  This runs on every resume (outside `ctx.step`), so a resumed-after-cancel run sees
  live terminal state and bails before re-completing. Check only `cancelled`/`expired`
  — a legit resume sees `suspended` and must proceed.

### 4. Persist the deadline for UI
- Add `expiresAt timestamp (withTimezone, nullable)` to `_workflowExecutionSteps`
  (**real migration** via `./equin build`).
- Written **once** by the executor before `ctx.waitFor`, via a dedicated idempotent
  mutation `setStepExpiryIfUnset(stepId, expiresAt)`
  (`UPDATE … SET expires_at = ? WHERE id = ? AND expires_at IS NULL`). The
  `IS NULL` guard makes replays no-ops, so the stored value equals
  `firstSuspendTime + timeoutMs` and matches the racer's `run_at`. (Do **not** reuse
  `updateExecutionStep`, which writes unconditionally.)
- Add `expiresAt: z.string().nullable()` to `WorkflowExecutionStepSchema`; serialize
  `row.expiresAt?.toISOString() ?? null`.
- **UI:** suspended form shows a live "Expires in 2h" countdown. `RelativeTime` only
  renders *past* times, so use a small future-aware `formatTimeUntil` helper local to
  the user-input execution component (promote into the `relative-time` primitive only
  once a second consumer appears). Distinct `expired`/`cancelled` status badges.

### 5. Adjacent latent bug (fold in)
`run-job` re-writes `startedAt = new Date()` on **every replay** (the mark-running
write is not memoized), so a suspended step's "Started Xm ago" resets on each wake.
Fold `startedAt` into the memoized `createExecutionStep` INSERT so it is naturally
write-once.

### Out of scope → follow-up tasks
- **Escalation on expiry/long-wait** (notify/reassign a human) — larger feature.
- **Generalize bounded waits**: a default `timeoutMs` cap at the `ctx.waitFor`/engine
  layer so any *future* suspending step type is bounded by construction, not by
  per-executor discipline.
- Promote `formatTimeUntil` into the `relative-time` primitive when a 2nd consumer lands.

## Ordered implementation checklist

**Phase 1 — jobs plugin (teardown primitive)**
1. `plugins/infra/plugins/jobs/server/internal/tables.ts` — add `"cancelled"` to
   `_jobWaits.status` `$type` union.
2. New `plugins/infra/plugins/jobs/server/internal/abort-run.ts` — `abortDurableRun(workflowRunId)`.
3. `plugins/infra/plugins/jobs/server/index.ts` — `export { abortDurableRun }`.

**Phase 2 — engine core**
4. `…/engine/core/schemas.ts` — add `cancelled`,`expired` to both status enums;
   add `expiresAt: z.string().nullable()` to `WorkflowExecutionStepSchema`.

**Phase 3 — engine server**
5. `…/engine/server/internal/tables.ts` — add `expiresAt` column to
   `_workflowExecutionSteps` (**migration**).
6. `…/engine/server/internal/mutations.ts` — add `setStepExpiryIfUnset`; rewrite
   `cancelExecution` (status-first tx → `abortDurableRun` → delete trigger rows);
   fold `startedAt` into `createExecutionStep`.
7. `…/engine/server/internal/executor-registry.ts` — add `expired?: true` to `StepResult`.
8. `…/engine/server/internal/run-job.ts` — loop-top non-memoized terminal re-check;
   handle `result.expired` in the normal post-exec path.
9. `…/engine/server/internal/resources.ts` — serialize `expiresAt`.
10. `…/engine/server/index.ts` — export `setStepExpiryIfUnset`.

**Phase 4 — user-input step**
11. New `…/user-input/core/` — `ExpiresAfterSchema`, `DEFAULT_EXPIRES_AFTER`, `resolveTimeoutMs`.
12. `…/user-input/server/internal/executor.ts` — write expiry once, pass `timeoutMs`,
    `return { expired: true }` on null.
13. `…/user-input/web/components/user-input-config.tsx` — `expiresAfter` editor (amount + unit).
14. `…/user-input/web/components/user-input-execution.tsx` — countdown + expired/cancelled note.

**Phase 5 — UI status maps (compile-required)**
15. `…/engine/web/internal/step-status-badge.tsx` — add `cancelled`,`expired`.
16. `…/executions/web/components/execution-status-badge.tsx` — add `cancelled`,`expired`.
17. `…/executions/web/components/executions-section.tsx` — add `cancelled`,`expired` filter options.

**Phase 6 — build**
18. `./equin build` (generates the `expires_at` migration) then `./equin check`.

## Verification (end-to-end)
- **Expiry:** create a workflow with a `user-input` step, set `expiresAfter` to ~1 minute,
  run it, do **not** submit. Confirm: the suspended form shows a countdown; after the
  deadline the racer `jobs.resume` fires, the executor gets `null`, and step + execution
  flip to `expired`. Verify via UI badge and `query_db` on `_workflowExecutions` /
  `_workflowExecutionSteps` (`status='expired'`, `completedAt` set) and `_jobWaits`
  (`status='timed_out'`).
- **Cancel teardown:** run, leave suspended, Cancel. Confirm execution + step → `cancelled`,
  `_jobWaits` row → `cancelled`, no scheduled `jobs.resume.timeout:*` row remains
  (`query_db` on `graphile_worker._private_jobs`), and `_userInputSubmittedTriggers` for
  the execution is empty. Then POST a late submit to the submit endpoint → expect 409 and
  **no** resurrection (status stays `cancelled`).
- **Happy path unchanged:** run, submit before the deadline → step `completed`, execution
  continues/`completed`; the timeout racer is deleted (event-resume path).
- `bun test` any pure helpers added (`resolveTimeoutMs`, `formatTimeUntil`).
- `./equin check` passes (migrations-in-sync, type-check, boundaries).
