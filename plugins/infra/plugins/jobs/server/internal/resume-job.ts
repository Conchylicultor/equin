import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import {
  defineJob,
  UNSAFE_getRegisteredJob,
  UNSAFE_insertJobRow,
  type JobTaskPayload,
} from "./registry";
import {
  RESUME_KEYS,
  ResumeInputSchema,
  type ResumeInput,
} from "./resume-contract";
import { JobQueue } from "./queue";
import { _jobWaits } from "./tables";

// Builtin — registered once at jobs plugin boot. Targeted by every
// `ctx.waitFor(...)` trigger row and every `ctx.sleep(...)` / timeout
// scheduled job. On invocation: resolve the wait row, re-enqueue the target
// handler with the original input, and (for event-path) cancel the timeout
// racer.
export const jobsResumeJob = defineJob({
  name: "jobs.resume",
  description:
    "Wakes a job that was waiting on an event or a timer by re-queueing it with its original input.",
  internal: true,
  // Resolve a wait row and re-enqueue the target — two indexed DB writes and an
  // insert. No network, no spawn; the target's own execution lands in whatever
  // class the target declares, so routing must never queue behind heavy work.
  hold: "instant",
  input: ResumeInputSchema,
  // Event payload is whatever event the waiter subscribed to — accept any
  // object so the payload is captured verbatim and stored in
  // `_jobWaits.payloadJson` for the awaiting workflow to read on resume.
  event: z.record(z.unknown()),
  dedup: "none",
  // Bumped — resolving a wait involves two DB writes and a target enqueue;
  // each is idempotent, so safe to retry on transient failure.
  maxAttempts: 5,
  run: async ({ input, event }) => {
    const workflowRunId = input[RESUME_KEYS.workflowRunId];
    const waitName = input[RESUME_KEYS.waitName];
    const targetJobName = input[RESUME_KEYS.jobName];
    const originalInput = input[RESUME_KEYS.input];
    const isTimeout = input[RESUME_KEYS.timeout] === true;

    // The event payload (when present) is what gets stored for the awaiting
    // workflow. Direct timeout enqueues pass `event: undefined`; for
    // event-path resumes the dispatcher delivers the source event verbatim.
    const payloadRecord = (event ?? {}) as Record<string, unknown>;

    const existing = await db
      .select()
      .from(_jobWaits)
      .where(
        and(
          eq(_jobWaits.workflowRunId, workflowRunId),
          eq(_jobWaits.waitName, waitName),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) {
      // Workflow was cleaned up (completed earlier) — nothing to resume.
      return;
    }
    if (row.status !== "pending") {
      // Raced — the other racer won. Either timeout fired first and event
      // arrives late, or vice versa. Nothing to do.
      return;
    }

    await db
      .update(_jobWaits)
      .set({
        status: isTimeout ? "timed_out" : "resolved",
        payloadJson: isTimeout
          ? null
          : (payloadRecord as Record<string, unknown>),
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(_jobWaits.workflowRunId, workflowRunId),
          eq(_jobWaits.waitName, waitName),
        ),
      );

    const target = UNSAFE_getRegisteredJob(targetJobName);
    if (!target) {
      // Schema drift — the job was removed between suspend and resume.
      // Preserve the wait row (status now resolved/timed_out) so an operator
      // can diagnose; return cleanly so the events dispatcher doesn't retry.
      console.warn(
        `[jobs.resume] unknown target job "${targetJobName}" for workflow ${workflowRunId}:${waitName}`,
      );
      return;
    }

    // Re-enqueue the handler with the ORIGINAL input via `UNSAFE_insertJobRow`,
    // NOT through `target.enqueue`. The public enqueue
    // path runs `spec.input.parse(input)` on every call; re-running that on
    // an already-parsed value would apply the schema's `.transform()` a
    // second time and diverge for non-idempotent transforms. Resume uses
    // the value the handler last received — the worker validates with
    // safeParse before dispatch, so we don't lose drift detection.
    //
    // jobKey = workflowRunId means graphile collapses any stale row with
    // the same workflow key (replace mode).
    //
    // Note the job handed to `UNSAFE_insertJobRow` is `target`, the job being
    // RESUMED — not `jobs.resume` itself. This is the insertion that is easiest
    // to get wrong: a job declaring `serial` suspends on `ctx.waitFor`, and if
    // its resume row were inserted without the target's own queue name it would
    // come back OUTSIDE its queue and run alongside the sibling the queue exists
    // to exclude. Deriving from the registered target makes that impossible to
    // forget.
    await UNSAFE_insertJobRow(
      target,
      {
        jobName: targetJobName,
        workflowRunId,
        input: originalInput,
      } satisfies JobTaskPayload,
      { jobKey: workflowRunId, maxAttempts: target.maxAttempts },
    );

    // Event-path: cancel the scheduled timeout racer. We only know its
    // jobKey, not its id.
    if (!isTimeout) {
      await JobQueue.get().cancelUnstarted({
        key: `jobs.resume.timeout:${workflowRunId}:${waitName}`,
      });
    }
  },
});

/**
 * Schedule a `jobs.resume` row for a suspended workflow — the `scheduleResume`
 * every queue's dispatch hands `makeDurableCtx`, so a `ctx.waitFor` timeout or
 * a `ctx.sleep` wakes the run on whichever queue this host runs.
 *
 * Bypasses `defineJob.enqueue`'s per-job-name namespacing: the timeout `jobKey`
 * is a fully-formed identity owned by this scheduler, and the cancel in
 * `jobsResumeJob` / `abortDurableRun` matches on the bare form. Going through
 * `jobsResumeJob.enqueue` would prefix it with `jobs.resume:` and the cancel
 * would miss. The dispatch re-parses `input` against `inputSchema`, so skipping
 * the public parse loses no schema-drift detection.
 *
 * The jobKey is ours; the QUEUE NAME is not. `UNSAFE_insertJobRow` gives both
 * bypasses (verbatim payload, literal jobKey) while the queue derives the row's
 * routing from the registered `jobs.resume`.
 */
export async function scheduleResume(
  resumePayload: ResumeInput,
  opts: { jobKey: string; runAt?: Date },
): Promise<void> {
  const resumeJob = UNSAFE_getRegisteredJob("jobs.resume");
  if (!resumeJob) {
    throw new Error(
      "[jobs] jobs.resume not registered — jobs/server/index.ts must register jobsResumeJob",
    );
  }
  await UNSAFE_insertJobRow(
    resumeJob,
    {
      jobName: "jobs.resume",
      workflowRunId: opts.jobKey,
      input: resumePayload,
    } satisfies JobTaskPayload,
    {
      jobKey: opts.jobKey,
      runAt: opts.runAt,
      maxAttempts: resumeJob.maxAttempts,
    },
  );
}
