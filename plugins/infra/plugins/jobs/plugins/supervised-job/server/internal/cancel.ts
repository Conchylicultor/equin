import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { z } from "zod";
import { db } from "@plugins/database/server";
import { builtinLedgerFor } from "./builtin-ledger";
import {
  builtinLockedJobOf,
  type SupervisedJob,
} from "./define-supervised-job";
import { killSupervisedRun, type KillOutcome } from "./run/supervisor";

/**
 * Cancel one run of a supervised job: signal its process group and let the
 * workflow record what happened.
 *
 * **Cancelling a supervised job is ONE action, not two, and the missing second
 * half is deliberate.** The general advice for a durable workflow blocked on
 * `ctx.waitFor` is to kill the work AND call `abortDurableRun(workflowRunId)`,
 * because otherwise the workflow stays suspended until its timeout. That advice
 * inverts here, and following it would lose data:
 *
 * - The kill goes to the process GROUP, so the shim's TERM trap fires and writes
 *   an exit marker — `143 TERM`, an observed cancellation rather than a guess.
 *   That marker is what the suspended handler wakes on, and waking is what runs
 *   `onEnded`. **The wait is not a leak to plug; it is how the cancellation gets
 *   recorded.**
 * - `abortDurableRun` cancels the pending wait, so a later resume no-ops. Call
 *   it on a live supervised job and the handler never comes back: `onEnded`
 *   never runs, the ledger row is never stamped, and the kind's partial unique
 *   in-flight index then refuses every future run of that kind.
 *
 * So the workflow always closes itself, on every path a cancellation can take. A
 * SIGTERM leaves a marker and the wake is immediate; a hard SIGKILL leaves none,
 * and the handler's next bounded wake sees a dead pid and records the hard-kill
 * outcome. The one place `abortDurableRun` belongs is AFTER the outcome has been
 * recorded, which the wrapper's own handler does for itself.
 *
 * The pid comes from the kind's ledger rather than any in-memory map, so this
 * works on a run started by a previous backend.
 */
export function cancelSupervisedJob<N extends string, S extends z.ZodType>(
  job: SupervisedJob<N, S>,
  runId: string,
): Promise<KillOutcome> {
  return killSupervisedRun(job.kind, runId);
}

/** What `cancelSupervisedJobByLock` did. */
export type CancelByLockResult =
  /** The open run holding the lock is stamped cancelled; `outcome` is the signal. */
  | {
      readonly kind: "cancelled";
      readonly runId: string;
      readonly outcome: KillOutcome;
    }
  /** No run of this job holds `lock(input)`. */
  | { readonly kind: "not-running" };

/**
 * A user's Cancel: stop the run of `job` that holds `lock(input)`, and have it
 * recorded as cancelled rather than failed.
 *
 * The run's row is stamped `cancelled_at` FIRST, then signalled through
 * `cancelSupervisedJob`'s kill path (everything above holds: no
 * `abortDurableRun`, the wake records the outcome). Stamping first is what lets
 * the failure policy, reading the row after the wake, answer `done` — no retry,
 * no dead-letter — and `onEnded` see `cancelled: true`. A TERM sent any other
 * way (a reboot, `cancelSupervisedJob`) carries no stamp and stays a retryable
 * failure.
 *
 * Only for a single-child built-in-ledger job — its `lock` (or the job-wide
 * lock when it declared none) is how a caller names the run without holding
 * its id. Any other job throws.
 *
 * A run stamped while its child is still being spawned answers
 * `outcome: { ok: false, reason: "not-spawned" }`: the child then runs on, and
 * if it fails it still closes as cancelled.
 */
export async function cancelSupervisedJobByLock<
  N extends string,
  S extends z.ZodType,
>(
  job: SupervisedJob<N, S>,
  input: z.infer<S>,
  conn: NodePgDatabase = db,
): Promise<CancelByLockResult> {
  const locked = builtinLockedJobOf(job);
  if (locked === null) {
    throw new Error(
      `[supervised-job] ${job.name}: cancelSupervisedJobByLock needs a single-child built-in-ledger job — cancel an own-ledger run by id with cancelSupervisedJob.`,
    );
  }
  const runId = await builtinLedgerFor(locked.jobName, conn).markCancelled(
    locked.lock(input),
  );
  if (runId === null) return { kind: "not-running" };
  return {
    kind: "cancelled",
    runId,
    outcome: await cancelSupervisedJob(job, runId),
  };
}
