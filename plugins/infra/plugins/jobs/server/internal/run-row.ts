import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { recordEntrySpan } from "@plugins/infra/plugins/runtime-profiler/core";
import { UNSAFE_getRegisteredJob, type JobTaskPayload } from "./registry";
import { scheduleResume } from "./resume-job";
import { workflowRunIdFor } from "./run-identity";
import { isSuspendSignal, makeDurableCtx } from "./step-ctx";
import { classifyFailure, discardWorkflowLog } from "./workflow-log";
import { announceAttemptFailed, announceAttemptSettled } from "./attempt-seam";

/** How one run of a row ended, for the queue that dispatched it. */
export type JobRowOutcome =
  | { kind: "completed" }
  /** It suspended (`ctx.waitFor` / `ctx.sleep`): the row is done, and a
   *  `jobs.resume` row brings the workflow back. */
  | { kind: "suspended" }
  /** It threw. `retry` says whether another attempt of this row may run. */
  | { kind: "failed"; error: unknown; retry: boolean };

/**
 * Run one dequeued row of a registered job — the dispatch a queue provider
 * WITHOUT a runner of its own needs (`jobs/plugins/in-process`): input
 * validated against schema drift, the durable `ctx` keyed by the row's run id,
 * suspension recognised, a failure reported and classified, and the run's
 * step / wait logs discarded once the workflow is over.
 *
 * The desktop queue does NOT use this: graphile's dispatch interleaves its
 * advisory job lock and the hold-class deadline around the same steps
 * (`machine/internal/worker.ts`).
 *
 * `UNSAFE_` because calling it runs a handler outside any queue's bookkeeping;
 * only a queue implementation may.
 */
export async function UNSAFE_runJobRow(
  payload: JobTaskPayload,
  meta: { jobId: string; attempt: number; maxAttempts: number },
): Promise<JobRowOutcome> {
  const job = UNSAFE_getRegisteredJob(payload.jobName);
  if (!job) {
    const err = new Error(`[jobs] unknown job "${payload.jobName}"`);
    reportServerError({ message: err.message, stack: err.stack ?? null });
    return { kind: "failed", error: err, retry: false };
  }
  // Validation only — the stored payload is already in post-transform shape
  // (parsed once, at `enqueue()`); see `dispatch()` in the desktop worker.
  const validation = job.inputSchema.safeParse(payload.input);
  if (!validation.success) {
    const err = new Error(
      `[jobs] input schema drift for "${payload.jobName}": ${validation.error.message}`,
    );
    reportServerError({ message: err.message, stack: err.stack ?? null });
    return { kind: "failed", error: err, retry: false };
  }

  const workflowRunId = workflowRunIdFor(payload, meta.jobId);
  // No deadline on this queue: the signal is never aborted.
  const abort = new AbortController();
  const ctx = makeDurableCtx({
    jobId: meta.jobId,
    attempt: meta.attempt,
    workflowRunId,
    signal: abort.signal,
    jobName: payload.jobName,
    originalInput: payload.input,
    scheduleResume,
  });

  try {
    await recordEntrySpan("job", payload.jobName, () =>
      job.run({ input: payload.input, event: payload.event, ctx }),
    );
  } catch (err) {
    if (isSuspendSignal(err)) {
      announceRecovered(payload.jobName, meta, true);
      return { kind: "suspended" };
    }
    const errObj = err instanceof Error ? err : new Error(String(err));
    const finality = classifyFailure({
      err,
      deadlineAborted: false,
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
    });
    // As the desktop's dispatch: every failed attempt is reported, and how
    // its run ends follows on the same seam.
    announceAttemptFailed({
      jobName: payload.jobName,
      jobId: meta.jobId,
      workflowRunId,
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
      retrying: !finality.workflowDead,
      message: errObj.message,
      stack: errObj.stack ?? null,
      errorType: errObj.name,
    });
    if (finality.workflowDead) await discardWorkflowLog(workflowRunId);
    return { kind: "failed", error: err, retry: !finality.workflowDead };
  }
  await discardWorkflowLog(workflowRunId);
  announceRecovered(payload.jobName, meta, false);
  return { kind: "completed" };
}

// An attempt after the first got through (`attempt-seam.ts`).
function announceRecovered(
  jobName: string,
  meta: { jobId: string; attempt: number },
  suspended: boolean,
): void {
  if (meta.attempt <= 1) return;
  announceAttemptSettled(
    { jobName, jobId: meta.jobId },
    { kind: "recovered", attempt: meta.attempt, suspended },
  );
}
