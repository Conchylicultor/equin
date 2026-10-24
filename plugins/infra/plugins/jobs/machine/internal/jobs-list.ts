import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  executeOne,
  executeRows,
  type SqlExecutable,
} from "@plugins/database/plugins/sql-rows/core";
import type { LiveCutKey } from "@plugins/network/plugins/live/core";
import { filterSql } from "@plugins/network/plugins/live/plugins/filter/server";
import { HoldClassSchema } from "../../core/hold";
import { JobStateSchema, jobs, type JobRow } from "../../core/resources";
import {
  jobsOrderOf,
  type JobsCountQuery,
  type JobsGroupQuery,
  type JobsWindowQuery,
} from "../../server/internal/jobs-window";
import type { JobQueueImpl } from "../../server/internal/queue";
import { isSlotForfeited } from "./forfeit";
import {
  jobHoldExpr,
  jobLockHeldExpr,
  jobNameExpr,
  jobTaskScope,
  supersededExpr,
} from "./introspection";

// The `jobs` collection's questions (`JobQueue`'s `window` / `rows` /
// `groups` / `count`), answered over graphile's `_private_jobs` — the queue
// Debug → Queue lists.
//
// Every question reads ONE relation, `r` below: a queue row per graphile row,
// its derived fields computed once (the state, the job name, the hold class),
// so a filter, a grouping and a cut all name the same expressions. The window
// is a keyset on `(run_at_ms, id)`: the row's `run_at` cut to ms — exactly
// what its `$key` text says (`jobRunAtKeyText`, `Date#toISOString()`, which
// `run_at` below is spelled as) — then graphile's id as TEXT in the `C`
// collation, the order the served half checks every answer against. A cut's
// instant binds back as `timestamptz`, so the comparison is on the instant,
// never on text.
//
// `state` is what graphile believes (`locked_at` stamped ⇒ "running"); `alive`
// is whether a worker is actually still there, read straight off `pg_locks` via
// the shared `jobLockHeldExpr`. Surfacing both is the point: a row that is
// `running` with `alive = false` is exactly the "worker died mid-handler" case
// the stuck-lock sweeper exists to reclaim. Scoped by CASE to locked rows —
// asking "does a worker hold this row's lock" of a pending row has no meaning,
// and answering `false` there would read as a fault. The CASE also keeps the
// cost honest: only the taken branch is evaluated, so the pg_locks scan runs
// for the handful of locked rows.
//
// An UNLOCKED superseded row (`supersededExpr`) is never listed: its run is
// over, a newer copy of the job is queued, and the stuck-lock sweeper deletes
// it on its next tick. Listing it would show a "dead" row in the seconds before
// that — the exact false alarm the flag exists to stop. A LOCKED superseded row
// is still a live run and keeps showing as "running".
//
// The timestamps cross as ISO text the query spells (`isoExpr`), so the
// driver's per-client `timestamptz` decoding (a string through drizzle, a
// `Date` through a raw client) never decides their shape.

/** A `timestamptz` as `Date#toISOString()` spells it: UTC, cut to ms. */
function isoExpr(expr: SQL): SQL {
  return sql`to_char(date_trunc('milliseconds', ${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

const stateExpr = sql`CASE
    WHEN j.locked_at IS NOT NULL THEN 'running'
    WHEN j.attempts >= j.max_attempts THEN 'dead'
    WHEN j.attempts > 0 THEN 'retrying'
    ELSE 'pending'
  END`;

/** Every queue row the collection lists, its fields named as the SQL reads them. */
const jobsRelation = sql`(
  SELECT j.id::text AS id,
         ${jobNameExpr} AS job_name,
         ${stateExpr} AS state,
         ${jobHoldExpr} AS hold,
         j.attempts::int AS attempts,
         j.max_attempts::int AS max_attempts,
         date_trunc('milliseconds', j.run_at) AS run_at_ms,
         ${isoExpr(sql`j.run_at`)} AS run_at,
         j.last_error,
         j.payload->'input' AS input,
         ${isoExpr(sql`j.locked_at`)} AS locked_at,
         j.locked_by,
         CASE WHEN j.locked_at IS NULL THEN NULL ELSE ${jobLockHeldExpr} END AS alive,
         q.queue_name,
         j.priority::int AS priority,
         ${isoExpr(sql`j.created_at`)} AS created_at,
         ${isoExpr(sql`j.updated_at`)} AS updated_at
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
   WHERE ${jobTaskScope}
     AND NOT (j.locked_at IS NULL AND ${supersededExpr})
) r`;

/** Each filterable field of `jobs`, as the SQL over `r` reads it. */
const FILTER_TARGETS = {
  jobName: sql`r.job_name`,
  state: sql`r.state`,
  hold: sql`r.hold`,
  attempts: sql`r.attempts`,
  runAt: sql`r.run_at_ms`,
  lastError: sql`r.last_error`,
} satisfies Record<keyof typeof jobs.filterable, SQL>;

/** `where` as a predicate over `r` — `TRUE` for the absent filter. */
function whereSql(where: JobsCountQuery["where"]): SQL {
  return filterSql(where, FILTER_TARGETS, jobs.filterable) ?? sql`TRUE`;
}

const isoInstant = z.string().transform((s, ctx) => {
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: "custom", message: `not an instant: ${s}` });
    return z.NEVER;
  }
  return date;
});

const JobsRelationRowSchema = z.object({
  id: z.string(),
  job_name: z.string(),
  state: JobStateSchema,
  // The class read off the row's task by `jobHoldExpr`; `jobTaskScope`
  // restricts the read to the tasks that CASE covers, so a value outside the
  // enum means the two have drifted — which the parse catches.
  hold: HoldClassSchema,
  attempts: z.number(),
  max_attempts: z.number(),
  run_at: isoInstant,
  last_error: z.string().nullable(),
  // `payload` is `json NOT NULL`; its `input` may be absent (SQL NULL).
  input: z.unknown(),
  locked_at: isoInstant.nullable(),
  locked_by: z.string().nullable(),
  // NULL for any row that is not locked — see the CASE above.
  alive: z.boolean().nullable(),
  // Nullable through the LEFT JOIN: a row with no named queue has no `q` row.
  queue_name: z.string().nullable(),
  priority: z.number(),
  created_at: isoInstant,
  updated_at: isoInstant,
});
type JobsRelationRow = z.infer<typeof JobsRelationRowSchema>;

const COLUMNS = sql`r.id, r.job_name, r.state, r.hold, r.attempts, r.max_attempts,
  r.run_at, r.last_error, r.input, r.locked_at, r.locked_by, r.alive,
  r.queue_name, r.priority, r.created_at, r.updated_at`;

function toJobRow(r: JobsRelationRow): JobRow {
  return {
    id: r.id,
    jobName: r.job_name,
    state: r.state,
    hold: r.hold,
    attempts: r.attempts,
    runAt: r.run_at,
    lastError: r.last_error,
    input: r.input ?? null,
    maxAttempts: r.max_attempts,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    alive: r.alive,
    // Process state, not a column — same reasoning as `queryRunningJobs`. A
    // row this backend never dispatched (or dispatched and finished) reads
    // `false`.
    forfeited: isSlotForfeited(r.id),
    queueName: r.queue_name,
    priority: r.priority,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A cut's instant part — the `$key` text of a `runAt`, never NULL. */
function cutInstant(cut: LiveCutKey, which: string): SQL {
  const [instant, id] = cut;
  if (
    instant === null ||
    instant === undefined ||
    id === null ||
    id === undefined
  ) {
    throw new Error(
      `jobs: the ${which} cut ${JSON.stringify(cut)} has no instant or id — a queue row's runAt is never NULL`,
    );
  }
  return sql`${instant}::timestamptz`;
}

/** The rows strictly past `cut` in the window's order (`desc` on the instant, the id ascending). */
function afterSql(cut: LiveCutKey, desc: boolean): SQL {
  const at = cutInstant(cut, "after");
  const id = cut[1]!;
  return sql`(r.run_at_ms ${sql.raw(desc ? "<" : ">")} ${at}
    OR (r.run_at_ms = ${at} AND r.id COLLATE "C" > ${id}))`;
}

/** The rows at or before `cut` in the window's order. */
function untilSql(cut: LiveCutKey, desc: boolean): SQL {
  const at = cutInstant(cut, "until");
  const id = cut[1]!;
  return sql`(r.run_at_ms ${sql.raw(desc ? ">" : "<")} ${at}
    OR (r.run_at_ms = ${at} AND r.id COLLATE "C" <= ${id}))`;
}

const GroupRowSchema = z.object({
  value: z.union([z.string(), z.number(), z.null()]),
  count: z.number(),
});

/** Each groupable field of `jobs`, as the SQL over `r` reads it. */
const GROUP_TARGETS: Record<JobsGroupQuery["groupBy"], SQL> = FILTER_TARGETS;

/**
 * The `jobs` answers over `db`'s graphile schema — the desktop queue's, on the
 * backend's own database (`graphileQueue`), and a throwaway one in a test.
 */
export function graphileJobReads(
  db: SqlExecutable<SQL>,
): Pick<JobQueueImpl, "window" | "rows" | "groups" | "count"> {
  return {
    async window(q: JobsWindowQuery) {
      const desc = jobsOrderOf(q) === "desc";
      const rows = await executeRows(db, {
        label: "jobs.window",
        row: JobsRelationRowSchema,
        query: sql`SELECT ${COLUMNS} FROM ${jobsRelation}
          WHERE ${whereSql(q.where)}
            ${q.after === undefined ? sql`` : sql`AND ${afterSql(q.after, desc)}`}
            ${q.until === undefined ? sql`` : sql`AND ${untilSql(q.until, desc)}`}
          ORDER BY r.run_at_ms ${sql.raw(desc ? "DESC" : "ASC")}, r.id COLLATE "C" ASC
          LIMIT ${q.limit}`,
      });
      return rows.map(toJobRow);
    },
    async rows(ids: readonly string[]) {
      if (ids.length === 0) return [];
      const rows = await executeRows(db, {
        label: "jobs.rows",
        row: JobsRelationRowSchema,
        query: sql`SELECT ${COLUMNS} FROM ${jobsRelation}
          WHERE r.id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
      });
      return rows.map(toJobRow);
    },
    async groups(q: JobsGroupQuery) {
      const target = GROUP_TARGETS[q.groupBy];
      return executeRows(db, {
        label: "jobs.groups",
        row: GroupRowSchema,
        query: sql`SELECT ${target} AS value, count(*)::int AS count
          FROM ${jobsRelation}
          WHERE ${whereSql(q.where)}
          GROUP BY 1
          ORDER BY count(*) DESC, 1 NULLS LAST
          LIMIT ${q.limit}`,
      });
    },
    async count(q: JobsCountQuery) {
      const { count } = await executeOne(db, {
        label: "jobs.count",
        row: z.object({ count: z.number() }),
        query: sql`SELECT count(*)::int AS count FROM ${jobsRelation}
          WHERE ${whereSql(q.where)}`,
      });
      return count;
    },
  };
}
