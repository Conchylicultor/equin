import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { JobQueue } from "./queue";
import { _jobWaits } from "./tables";

/**
 * Tears down a durable run's outstanding suspension state. Best-effort and
 * idempotent — safe to call on an already-finished run or one that never
 * suspended. The jobs plugin owns `_jobWaits` and the resume jobKey conventions,
 * so this teardown lives here (callers stay boundary-clean by passing only the
 * opaque `workflowRunId`).
 *
 * 1. Mark any pending wait rows `cancelled` — so a late `jobs.resume` no-ops
 *    (resume-job.ts bails when the wait row is non-pending).
 * 2. Delete the not-yet-started timeout / sleep racer jobs for this run.
 * 3. Delete a not-yet-started resume of the main handler (jobKey === run).
 *
 * Only not-yet-started queue rows are dropped (`cancelUnstarted`), so an
 * in-flight resume is left to finish; the cancelled wait row makes it no-op.
 */
export async function abortDurableRun(workflowRunId: string): Promise<void> {
  await db
    .update(_jobWaits)
    .set({ status: "cancelled", resolvedAt: new Date() })
    .where(
      and(
        eq(_jobWaits.workflowRunId, workflowRunId),
        eq(_jobWaits.status, "pending"),
      ),
    );

  // Cancel the scheduled timeout / sleep racers (we only know their jobKey
  // prefix, not their ids), then a not-yet-started resume of the main handler
  // (jobKey === run).
  const queue = JobQueue.get();
  await queue.cancelUnstarted({
    keyPrefix: `jobs.resume.timeout:${workflowRunId}:`,
  });
  await queue.cancelUnstarted({
    keyPrefix: `jobs.resume.sleep:${workflowRunId}:`,
  });
  await queue.cancelUnstarted({ key: workflowRunId });
}
