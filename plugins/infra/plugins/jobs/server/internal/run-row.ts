import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { recordEntrySpan } from "@plugins/infra/plugins/runtime-profiler/core";
import { UNSAFE_getRegisteredJob, type JobTaskPayload } from "./registry";
import { scheduleResume } from "./resume-job";
import { workflowRunIdFor } from "./run-identity";
import { isSuspendSignal, makeDurableCtx } from "./step-ctx";
import { classifyFailure, discardWorkflowLog } from "./workflow-log";

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
    if (isSuspendSignal(err)) return { kind: "suspended" };
    const errObj = err instanceof Error ? err : new Error(String(err));
    reportServerError({
      message: `[jobs] ${payload.jobName} failed (attempt ${meta.attempt}): ${errObj.message}`,
      stack: errObj.stack ?? null,
      errorType: errObj.name,
    });
    const finality = classifyFailure({
      err,
      deadlineAborted: false,
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
    });
    if (finality.workflowDead) await discardWorkflowLog(workflowRunId);
    return { kind: "failed", error: err, retry: !finality.workflowDead };
  }
  await discardWorkflowLog(workflowRunId);
  return { kind: "completed" };
}
