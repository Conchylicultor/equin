import { sql, type SQL } from "drizzle-orm";
import type { ColumnRef } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { ColumnExpr } from "@plugins/primitives/plugins/keyset/server";
import type { ReleaseRun } from "@plugins/release/core";
import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";

/**
 * How each release status reads on the shared outcome axis.
 *
 * The mapping happens to be one-to-one today, which is exactly why it is written
 * out rather than passed through. `release_runs.status` is a closed set the
 * release engine owns and can widen; a pass-through would let a fourth value
 * leak straight into `outcome`, where it is not a member of the vocabulary, and
 * the failure would surface as a zod throw far from the column that caused it. A
 * `Record<ReleaseRun["status"], RunOutcome>` makes widening a `tsc` error here
 * instead.
 */
const OUTCOME_OF_STATUS: Record<ReleaseRun["status"], RunOutcome> = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};

/**
 * The shared `outcome`, from the release ledger's own status column.
 *
 * Two things are deliberate. There is **no `else`**: a status outside the map
 * projects NULL, and the arm's `RunOutcomeSchema` decoder refuses it on it rather
 * than an unlabelled row reaching the list — `outcome-sql.test.ts` drives a
 * value the map does not cover through it to hold that true. And the `::text`
 * cast is on the whole expression, because every arm of a `UNION ALL` has to
 * agree on a column's type and that is not a thing to leave to Postgres' literal
 * resolution.
 *
 * Takes the status column as an argument rather than closing over
 * `_releaseRuns.status`, so the suite can evaluate it over a parameter and needs
 * no table, no migration chain and no fixture rows.
 */
export function releaseOutcomeExpr(status: ColumnExpr | ColumnRef): SQL {
  const whens = Object.entries(OUTCOME_OF_STATUS).map(
    ([from, to]) => sql`when ${from} then ${to}`,
  );
  return sql`(case ${status} ${sql.join(whens, sql` `)} end)::text`;
}
