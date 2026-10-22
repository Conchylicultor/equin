import { sql, type SQL } from "drizzle-orm";
import { _opLogOps } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/server";
import type { PushBucket as Bucket } from "../../shared/values";

const t = _opLogOps;

/**
 * The bucket key of an op's `requested_at`, in UTC: `YYYY-MM-DD` for a day,
 * the Monday of its ISO week for a week (`date_trunc('week')` is Monday-based),
 * `YYYY-MM` for a month. Lexically ordered, so `ORDER BY` on it is by time.
 */
function bucketKey(bucket: Bucket): SQL {
  const utc = sql`(${t.requestedAt} AT TIME ZONE 'UTC')`;
  switch (bucket) {
    case "day":
      return sql`to_char(${utc}, 'YYYY-MM-DD')`;
    case "week":
      return sql`to_char(date_trunc('week', ${utc}), 'YYYY-MM-DD')`;
    case "month":
      return sql`to_char(${utc}, 'YYYY-MM')`;
  }
}

/**
 * The completed pushes these stats aggregate over, as a subquery of
 * `(op_id, bucket, closed_wait_ms, outcome, steps)` rows over the op-store's
 * `op_log_ops` table (the DB fold of `op-log.jsonl`, 30-day retention).
 *
 * Two exclusions, both deliberate, both required for an aggregate to mean
 * anything:
 *
 * - **In-flight ops** (`closed_by IS NULL`). An unfinished push has no final
 *   outcome (throughput cannot say success or failed), its wait is still
 *   growing, and it has no steps yet — counting it would make a chart depend on
 *   when it was loaded.
 * - **Interrupted ops.** Hard-killed and closed by the reconciler (or a
 *   worktree's ingest-gap close). They carry no real duration and no steps — a
 *   synthetic zero, not a measurement.
 *
 * `closed_wait_ms` is `sum(waits.durationMs)` — every wait the push blocked on,
 * including the nested host-grant wait inside its `checks` step.
 */
export function completedPushes(bucket: Bucket): SQL {
  return sql`(
    SELECT ${t.opId} AS op_id,
           ${bucketKey(bucket)} AS bucket,
           ${t.closedWaitMs} AS closed_wait_ms,
           ${t.outcome} AS outcome,
           ${t.steps} AS steps
      FROM ${t}
     WHERE ${t.kind} = 'push'
       AND ${t.closedBy} IS NOT NULL
       AND ${t.outcome} IS NOT NULL
       AND NOT ${t.interrupted}
  )`;
}

/** Seconds, rounded to 2 decimals — the charts' unit. */
export function msToSeconds(ms: number): number {
  return Math.round((ms / 1000) * 100) / 100;
}
