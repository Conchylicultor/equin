import { sql, type SQL } from "drizzle-orm";
import type { ColumnRef } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { ColumnExpr } from "@plugins/primitives/plugins/keyset/server";

/** A column the expression reads: a column or expression, or a `j` ref (which renders as one). */
type Operand = ColumnExpr | ColumnRef;
import {
  BUILD_EXIT_HARD_KILLED,
  BUILD_EXIT_SIGNAL_BASE,
  BUILD_EXIT_SUPERSEDED,
  type BuildStatus,
} from "@plugins/build/plugins/build-status/core";
import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";

/**
 * `buildStatusOf`, as SQL.
 *
 * This is the one genuinely duplicated rule in the arm, and it is duplicated for
 * a reason that cannot be designed away here: the union query has to decide a
 * row's status *in Postgres*, inside an `ORDER BY`-able projection, so a
 * TypeScript predicate over a fetched row is not available at the point the
 * decision is needed. Two encodings of one rule is a drift hazard, so:
 *
 * - Both read the SAME exported constants. Nothing is re-typed as a literal, so
 *   the numbers cannot drift even if the branches do.
 * - `status-sql.test.ts` drives a table of `(finishedAt, exitCode)` samples —
 *   every branch, and both sides of every boundary — through the TypeScript
 *   function and through this expression on a real Postgres, and asserts they
 *   agree. A branch that drifts fails that suite.
 *
 * Branch order matters and mirrors the function exactly. Note the NULL
 * behaviour is load-bearing on the last comparison: `null > 128` is NULL in SQL,
 * which falls through to `else 'failed'` — the same answer as the function's
 * `exitCode !== null &&` guard, reached a different way.
 */
export function buildStatusExpr(finishedAt: Operand, exitCode: Operand): SQL {
  // `::text` on the whole expression, not on each branch: every arm of a
  // `UNION ALL` must agree on a column's type, and an all-`unknown` CASE would
  // leave that to Postgres' literal resolution rather than saying it.
  return sql`(case
    when ${finishedAt} is null then 'running'
    when ${exitCode} = 0 then 'success'
    when ${exitCode} = ${BUILD_EXIT_SUPERSEDED} then 'superseded'
    when ${exitCode} = ${BUILD_EXIT_HARD_KILLED} then 'interrupted'
    when ${exitCode} > ${BUILD_EXIT_SIGNAL_BASE} then 'killed'
    else 'failed'
  end)::text`;
}

/**
 * How each of the six build statuses reads on the shared outcome axis.
 *
 * A `Record<BuildStatus, RunOutcome>` rather than a hand-written `CASE`: adding
 * a seventh build status is then a `tsc` error here rather than a run that
 * silently loses its outcome. The three cancellations collapse because none of
 * them is a verdict on the code — see `BuildStatus`'s own docblock.
 */
const OUTCOME_OF_STATUS: Record<BuildStatus, RunOutcome> = {
  running: "running",
  success: "succeeded",
  failed: "failed",
  superseded: "canceled",
  interrupted: "canceled",
  killed: "canceled",
};

/**
 * The shared `outcome`, derived from the build status rather than re-decided
 * from the exit code. One encoding of the exit-code rule, and a separate,
 * provably total mapping on top of it.
 *
 * Deliberately has no `else`: a status this map does not cover projects NULL,
 * and `UnionRunSchema`'s `RunOutcomeSchema` throws on it. An unlabelled row is
 * never quietly put on screen.
 */
export function buildOutcomeExpr(status: SQL): SQL {
  const whens = Object.entries(OUTCOME_OF_STATUS).map(
    ([from, to]) => sql`when ${from} then ${to}`,
  );
  return sql`(case ${status} ${sql.join(whens, sql` `)} end)::text`;
}
