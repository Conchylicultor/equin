import { sql, type SQL } from "drizzle-orm";
import type { ColumnRef } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { ColumnExpr } from "@plugins/primitives/plugins/keyset/server";
import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";

/**
 * How a completed run's conclusion reads on the shared outcome axis. GitHub's
 * vocabulary is an open set it may grow (the row stores it as text), so a
 * conclusion missing here reads `failed` — a completed run that cannot be
 * shown to have passed is not claimed to have.
 */
const OUTCOME_OF_CONCLUSION: Record<string, RunOutcome> = {
  success: "succeeded",
  // `neutral` / `skipped`: the run chose to do nothing (a tag that is not a
  // release ends the release workflow early as a success) — nothing failed.
  neutral: "succeeded",
  skipped: "succeeded",
  cancelled: "canceled",
  action_required: "needs-approval",
};

/**
 * The shared `outcome`, from GitHub's `status` and `conclusion`: anything not
 * `completed` (queued, waiting, in progress…) is `running`; a completed run
 * reads its conclusion through {@link OUTCOME_OF_CONCLUSION}, else `failed`
 * (`failure`, `timed_out`, `startup_failure`, a word GitHub adds later).
 *
 * Takes the columns as arguments, so the suite evaluates it over parameters
 * with no table.
 */
export function githubOutcomeExpr(
  status: ColumnExpr | ColumnRef,
  conclusion: ColumnExpr | ColumnRef,
): SQL {
  const whens = Object.entries(OUTCOME_OF_CONCLUSION).map(
    ([from, to]) => sql`when ${conclusion} = ${from} then ${to}`,
  );
  return sql`(case when ${status} <> 'completed' then 'running' ${sql.join(whens, sql` `)} else 'failed' end)::text`;
}
