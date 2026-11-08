import type { CrashFields } from "@plugins/packages/plugins/error-subject/core";
import { defineRequestSink } from "@plugins/primitives/plugins/report-sink/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import type { RunDeathCause } from "./run-death";

/**
 * The seam a run's attempts are announced on: each attempt that threw, and —
 * once — how the run that attempt belonged to ended.
 *
 * Every failed attempt is reported, retry or not: a retry that succeeds turns
 * a deterministic bug into a flaky one, it does not explain it. What a report
 * of one attempt cannot know when it is filed is what happened NEXT, so the
 * queue announces that too, and the consumer (`jobs/plugins/attempt-audit`)
 * restates the attempt's report with it: recovered on attempt N, or gave up.
 *
 * A seam rather than a `reports` import for the reasons `deadline-seam.ts`
 * gives (layering, and the `reports` → `jobs` cycle).
 */
export type JobAttemptEvent =
  /** One attempt of a run threw. */
  | {
      phase: "failed";
      jobName: string;
      /** The queue row — what a later `settled` names. */
      jobId: string;
      workflowRunId: string;
      /** 1-indexed. */
      attempt: number;
      maxAttempts: number;
      /** Whether the queue will run another attempt of this row. A `false`
       * is followed by the row's `settled` (`dead`, or `superseded`). */
      retrying: boolean;
      message: string;
      /** The error's crash fields (`crashFieldsOf`): its type, stack and
       * what it says it is about (a shared throw site's subject, its cause's
       * class code) — with the job's name, the report's identity, so two
       * causes of one job's failure through shared code are two rows. */
      crash: CrashFields;
    }
  /** The run of a row is over for good, or a later attempt got through. */
  | {
      phase: "settled";
      jobName: string;
      jobId: string;
      outcome: JobAttemptOutcome;
    };

export type JobAttemptOutcome =
  /** Attempt `attempt` (> 1) completed, or suspended (`ctx.waitFor` /
   * `ctx.sleep`): it got past whatever stopped the attempts before it. */
  | { kind: "recovered"; attempt: number; suspended: boolean }
  /** No attempt of the run will ever come (`announceRunDead`). */
  | { kind: "dead"; cause: RunDeathCause; error: string }
  /** A re-queue of the row's key retired it while it ran: a newer row owns
   * the run, and the run's outcome is that row's. */
  | { kind: "superseded" };

/**
 * `true` from the handler: the event has a durable home and is on its way
 * there. For a `failed` event anything else (`undefined` — nobody attached,
 * as before boot or on a host without the reports engine — or `false`) falls
 * back to a plain server error, so a failed attempt can never go unreported.
 */
export const jobAttemptSink = defineRequestSink<JobAttemptEvent, boolean>();

/** Announce a failed attempt; reported as a plain server error when no
 * consumer owns it. Never throws (the failure path must not gain a second
 * failure mode). */
export function announceAttemptFailed(
  event: Omit<Extract<JobAttemptEvent, { phase: "failed" }>, "phase">,
): void {
  if (jobAttemptSink.emit({ phase: "failed", ...event }) === true) return;
  reportServerError({
    message: `[jobs] ${event.jobName} failed (attempt ${event.attempt}): ${event.message}`,
    ...event.crash,
    scope:
      event.crash.scope === null
        ? event.jobName
        : `${event.jobName} › ${event.crash.scope}`,
  });
}

/** Announce how a row's run ended. Nothing to fall back to: with no consumer
 * there is no attempt report to restate. */
export function announceAttemptSettled(
  run: { jobName: string; jobId: string },
  outcome: JobAttemptOutcome,
): void {
  jobAttemptSink.emit({ phase: "settled", ...run, outcome });
}
