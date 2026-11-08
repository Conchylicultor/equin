import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { runInBackgroundLane } from "@plugins/infra/plugins/runtime-profiler/core";
import { UNSAFE_getRegisteredJob, type JobTaskPayload } from "./registry";
import { announceAttemptSettled } from "./attempt-seam";

/**
 * How a run ended for good — no attempt of it will ever run again. One of
 * the four places a queue decides that:
 *
 * - `failed` — its last attempt threw (or a non-retryable failure, or a
 *   second deadline overrun, collapsed its budget). The handler saw the
 *   error itself.
 * - `worker-died` — its worker died mid-run on its LAST attempt (a restart,
 *   a crash): the stuck-lock sweeper released a row with no attempt left. No
 *   code of the handler saw it end.
 * - `wake-failed` — it was suspended on a wait, and the `jobs.resume` that
 *   was to wake it died: nothing will ever resume it.
 * - `cancelled` — its row was removed (Debug → Queue).
 */
export type RunDeathCause =
  "failed" | "worker-died" | "wake-failed" | "cancelled";

export interface RunDeath {
  cause: RunDeathCause;
  /** What ended it, in words — the error message, or what the queue saw. */
  error: string;
}

/**
 * Tell a run's job that the run is dead (`defineJob({ onDead })`). Called by
 * each queue at the instant it decides so, AFTER the run stops counting as in
 * flight (`keysInFlight`), so whatever `onDead` sets off reads the run as
 * over.
 *
 * `jobId` is the queue row the run died on, announced on the attempt seam
 * (`attempt-seam.ts`) so a report of one of its failed attempts can say the
 * run gave up. `null` for a run with no row left to name (`wake-failed`: the
 * suspended run's rows are gone, and each was settled when it suspended).
 *
 * Never throws: the queue's own outcome (a recorded failure, a released row)
 * must not be replaced by a complaint about the hook. A hook that throws is
 * reported loudly, and what it would have recorded still follows from the
 * queue (the run no longer holds its key).
 */
export async function announceRunDead(
  payload: Pick<JobTaskPayload, "jobName" | "input">,
  death: RunDeath,
  jobId: string | null,
): Promise<void> {
  if (jobId !== null) {
    announceAttemptSettled(
      { jobName: payload.jobName, jobId },
      { kind: "dead", cause: death.cause, error: death.error },
    );
  }
  const job = UNSAFE_getRegisteredJob(payload.jobName);
  if (job?.onDead === undefined) return;
  // A row whose input no longer parses (schema drift) cannot be handed to a
  // typed hook; its owner learns of it from the run no longer being in flight.
  if (!job.inputSchema.safeParse(payload.input).success) return;
  const onDead = job.onDead;
  try {
    await runInBackgroundLane(() => onDead({ input: payload.input, death }));
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    reportServerError({
      message: `[jobs] ${payload.jobName}: onDead (${death.cause}) threw: ${errObj.message}`,
      ...crashFieldsOf(errObj, payload.jobName),
    });
  }
}
