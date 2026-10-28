import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { runInBackgroundLane } from "@plugins/infra/plugins/runtime-profiler/core";
import { isNonRetryableError } from "./non-retryable";
import type { EnqueueTx } from "./registry";
import { _jobSteps, _jobWaits } from "./tables";

/**
 * What a failed attempt means for the two things `dispatch()` can do about it.
 * One classification, so the retry-budget collapse and the log teardown cannot
 * drift apart: `workflowDead` is a superset of `collapseBudget` by construction.
 */
export interface FailureFinality {
  /**
   * Collapse graphile's retry budget so the row dead-letters after THIS
   * attempt instead of burning the rest of `maxAttempts`.
   */
  collapseBudget: boolean;
  /**
   * No further attempt of this workflow will run, so its `_jobSteps` /
   * `_jobWaits` rows can never be legitimately replayed again.
   */
  workflowDead: boolean;
}

/**
 * Decide, from one failed attempt, whether the workflow is finished.
 *
 * The two `collapseBudget` arms are the pre-existing policy (see the long
 * comment at the call site in worker.ts): a deterministic failure, and a run
 * aborted by its own deadline from the second attempt on. `workflowDead` adds
 * the case graphile reaches on its own — a plain `Error` that exhausted
 * `maxAttempts` — which no in-process branch used to name at all.
 *
 * `attempt` and `maxAttempts` are the row's own values as fetched (graphile
 * increments `attempts` in `get_job`, so on the final attempt they are equal).
 */
export function classifyFailure(opts: {
  err: unknown;
  /** `ctx.signal` aborted, i.e. this run passed its hold class's deadline. */
  deadlineAborted: boolean;
  attempt: number;
  maxAttempts: number;
}): FailureFinality {
  const collapseBudget =
    isNonRetryableError(opts.err) ||
    (opts.deadlineAborted && opts.attempt >= 2);
  return {
    collapseBudget,
    workflowDead: collapseBudget || opts.attempt >= opts.maxAttempts,
  };
}

/**
 * Of `workflowRunIds`, the ones suspended right now: parked on a `ctx.waitFor`
 * / `ctx.sleep` whose wait is still pending. Such a run holds no queue row —
 * the suspend deleted it — yet it is still coming: a trigger or its timeout
 * racer re-enqueues it. A finished or dead run's log is discarded, so a
 * pending wait never outlives its workflow.
 */
export async function suspendedRunIds(
  workflowRunIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (workflowRunIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ id: _jobWaits.workflowRunId })
    .from(_jobWaits)
    .where(
      and(
        inArray(_jobWaits.workflowRunId, [...workflowRunIds]),
        eq(_jobWaits.status, "pending"),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * Delete one workflow run's step and wait logs. Takes the executor so the
 * caller decides which database and which transaction this lands in.
 *
 * Trigger rows outlive this cleanup — oneShot rows are deleted by the events
 * dispatcher after their target succeeds; an orphan from a never-fired trigger
 * is harmless (it fires → `jobs.resume` finds no wait row → returns).
 */
export async function deleteWorkflowLog(
  exec: EnqueueTx,
  workflowRunId: string,
): Promise<void> {
  await exec
    .delete(_jobSteps)
    .where(eq(_jobSteps.workflowRunId, workflowRunId));
  await exec
    .delete(_jobWaits)
    .where(eq(_jobWaits.workflowRunId, workflowRunId));
}

/**
 * {@link deleteWorkflowLog} for a whole set of runs, in two statements whatever
 * the set's size — for the sweeps that remove many queue rows at once. The ids
 * travel as ONE jsonb parameter: drizzle expands a JS array into one bound
 * parameter per element, and a large dead-row backlog would otherwise run into
 * Postgres's parameter cap.
 */
export async function deleteWorkflowLogs(
  exec: EnqueueTx,
  workflowRunIds: readonly string[],
): Promise<void> {
  if (workflowRunIds.length === 0) return;
  const ids = JSON.stringify(workflowRunIds);
  await exec
    .delete(_jobSteps)
    .where(
      sql`${_jobSteps.workflowRunId} IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`,
    );
  await exec
    .delete(_jobWaits)
    .where(
      sql`${_jobWaits.workflowRunId} IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`,
    );
}

/**
 * `deleteWorkflowLog` against the worktree database, on the terms a finished
 * dispatch needs: it never throws, and its DB work is declared background.
 *
 * Cleanup failures are logged, NOT rethrown. The dispatch that calls this has
 * already settled — succeeded, or failed for a reason graphile is about to
 * record — and rethrowing here would replace that outcome with a complaint
 * about dead-row cleanup. The leaked rows are bounded (one workflow's worth).
 *
 * Declared background deliberately: the `job` entry span wraps only
 * `job.run()`, so these deletes would otherwise land with no ambient entry, be
 * classified context-less, and take connections reserved for human-blocking
 * work to clean up after background work. Both awaits stay inside the lane
 * scope so their pool connections are acquired under the declaration. See
 * research/2026-07-09-global-interactive-lane-origin-based-db-gating.md.
 */
export async function discardWorkflowLog(workflowRunId: string): Promise<void> {
  await discardWorkflowLogs([workflowRunId]);
}

/**
 * {@link discardWorkflowLog} for a set of runs, on the same never-throw,
 * background-lane terms — for a sweep that has already removed the queue rows
 * and must not have its own outcome replaced by a cleanup complaint.
 * `database` is the worktree database in production; a test hands it a
 * throwaway one.
 */
export async function discardWorkflowLogs(
  workflowRunIds: readonly string[],
  database: EnqueueTx = db,
): Promise<void> {
  if (workflowRunIds.length === 0) return;
  try {
    await runInBackgroundLane(() =>
      deleteWorkflowLogs(database, workflowRunIds),
    );
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.warn(
      `[jobs] cleanup of step/wait logs failed for ${workflowRunIds.length} workflow(s), first ${workflowRunIds[0]}`,
      err,
    );
  }
}
