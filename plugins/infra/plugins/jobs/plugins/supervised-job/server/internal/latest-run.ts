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
 * Only for a built-in-ledger job that declared `lock`; any other job throws.
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
      `[supervised-job] ${job.name}: latestSupervisedRun needs a built-in-ledger job that declares \`lock\` — an own ledger reads its runs from its own table.`,
    );
  }
  return builtinLedgerFor(locked.jobName, conn).latest(locked.lock(input));
}
