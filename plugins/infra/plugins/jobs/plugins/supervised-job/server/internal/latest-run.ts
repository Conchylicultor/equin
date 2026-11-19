import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { z } from "zod";
import { db } from "@plugins/database/server";
import { builtinLedgerFor, type SupervisedRunRow } from "./builtin-ledger";
import {
  builtinLockedJobOf,
  type SupervisedJob,
} from "./define-supervised-job";

/**
 * The newest run of `job` holding `lock(input)` — open or closed — or `null`
 * when it never ran under that key (or the 30-day retention took it).
 *
 * For a workflow that requests a built-in-ledger job and waits for it: it names
 * the run the way the claim did (no run id to keep, the same shape as
 * `cancelSupervisedJobByLock`), and `job.kind.id` plus `id` is what
 * `runEnded` filters on. The row is read, never trusted as the whole answer —
 * the work's own result (a checkout on disk) stays the authority; this says
 * only whether a run is still going and, once over, why it failed.
 *
 * Only for a single-child built-in-ledger job (its `lock`, or the job-wide
 * lock when it declared none); any other job throws.
 */
export async function latestSupervisedRun<
  N extends string,
  S extends z.ZodType,
>(
  job: SupervisedJob<N, S>,
  input: z.infer<S>,
  conn: NodePgDatabase = db,
): Promise<SupervisedRunRow | null> {
  const locked = builtinLockedJobOf(job);
  if (locked === null) {
    throw new Error(
      `[supervised-job] ${job.name}: latestSupervisedRun needs a single-child built-in-ledger job — an own ledger reads its runs from its own table.`,
    );
  }
  return builtinLedgerFor(locked.jobName, conn).latest(locked.lock(input));
}

/**
 * The inputs among `inputs` whose run of `job` is open — claimed and not
 * closed: its child runs, or is being spawned. One read for the whole list
 * (every open run of the job), so a pass over many keys costs one query.
 *
 * The open row is the job's in-flight lock: a caller that must not touch what
 * a run is still making (a checkout mid-setup) skips these. Read it AFTER the
 * caller's own view of the work (a listing): work found then whose run is
 * closed by now has finished, or failed, before this read.
 *
 * Only for a single-child built-in-ledger job, as `latestSupervisedRun`.
 */
export async function openSupervisedRuns<N extends string, S extends z.ZodType>(
  job: SupervisedJob<N, S>,
  inputs: readonly z.infer<S>[],
  conn: NodePgDatabase = db,
): Promise<z.infer<S>[]> {
  const locked = builtinLockedJobOf(job);
  if (locked === null) {
    throw new Error(
      `[supervised-job] ${job.name}: openSupervisedRuns needs a single-child built-in-ledger job — an own ledger reads its runs from its own table.`,
    );
  }
  if (inputs.length === 0) return [];
  const open = await builtinLedgerFor(locked.jobName, conn).openLockKeys();
  return inputs.filter((input) => open.has(locked.lock(input)));
}
