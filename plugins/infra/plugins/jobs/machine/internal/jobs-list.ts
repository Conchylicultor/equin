import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { HoldClassSchema } from "../../core/hold";
import type { JobsPayload, JobState } from "../../core/resources";
import { isSlotForfeited } from "./forfeit";
import {
  jobHoldExpr,
  jobLockHeldExpr,
  jobTaskScope,
  supersededExpr,
} from "./introspection";

// One row of `graphile_worker._private_jobs`, as it actually arrives.
//
// The four timestamps are worth a word, because the answer depends on WHO ran
// the query. `drizzle-orm/node-postgres` attaches a per-query type-parser
// override (`node-postgres/session.js`) that hands `timestamptz` / `timestamp` /
// `date` / `interval` back as the RAW STRING, leaving the mapping to drizzle's
// own column types. A raw `pg` client has no such override and decodes the same
// OID 1184 column to a `Date`. So the identical `SELECT j.run_at` yields a
// string through `db.execute` and a `Date` through `pool.query` — and this
// query is the drizzle one. `z.string()` is the truth here; the very same
// column read through `openShortLivedClient` (as the timeline sources do) is
// `z.date()`.
//
// That split is invisible in the SQL and was got backwards once already, on the
// strength of a probe run against a raw client. It stopped being a guess the
// moment the read was parsed: the boundary named the column, the value and
// `OID 1184` and refused to continue.
const GraphileJobRowSchema = z.object({
  id: z.string(),
  task_identifier: z.string(),
  // The row's duration class, read off its task identifier by `jobHoldExpr`.
  // `jobTaskScope` restricts the query to the tasks that CASE covers, so a value
  // outside the enum means the two have drifted — which is what this now catches.
  hold: HoldClassSchema,
  // `payload` is `json NOT NULL`; only these two keys are read.
  payload: z.object({ jobName: z.string().optional(), input: z.unknown() }),
  // Nullable through the LEFT JOIN: a row with no named queue has no `q` row.
  queue_name: z.string().nullable(),
  priority: z.number(),
  run_at: z.string(),
  locked_at: z.string().nullable(),
  locked_by: z.string().nullable(),
  attempts: z.number(),
  max_attempts: z.number(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // NULL for any row that is not locked — see the CASE in the query below.
  alive: z.boolean().nullable(),
});
type GraphileJobRow = z.infer<typeof GraphileJobRowSchema>;

function deriveState(row: GraphileJobRow): JobState {
  if (row.locked_at !== null) return "running";
  if (row.attempts >= row.max_attempts) return "dead";
  if (row.attempts > 0) return "retrying";
  return "pending";
}

// `state` is what graphile believes (`locked_at` stamped ⇒ "running"); `alive`
// is whether a worker is actually still there, read straight off `pg_locks` via
// the shared `jobLockHeldExpr`. Surfacing both is the point: a row that is
// `running` with `alive = false` is exactly the "worker died mid-handler" case
// the stuck-lock sweeper exists to reclaim, and it is now visible in Debug →
// Queue instead of only inferable from a stale timestamp. Scoped by CASE to
// locked rows — asking "does a worker hold this row's lock" of a pending row has
// no meaning, and answering `false` there would read as a fault. The CASE also
// keeps the cost honest: only the taken branch is evaluated, so the pg_locks scan
// runs for the handful of locked rows, not all 500.
//
// An UNLOCKED superseded row (`supersededExpr`) is skipped: its run is over, a
// newer copy of the job is queued, and the stuck-lock sweeper deletes it on its
// next tick. Listing it would show a "dead" row in the seconds before that — the
// exact false alarm the flag exists to stop. A LOCKED superseded row is still a
// live run and keeps showing as "running".
export async function loadJobsList(limit = 500): Promise<JobsPayload> {
  const raw = await executeRows(db, {
    label: "jobs-list",
    row: GraphileJobRowSchema,
    query: sql`SELECT j.id::text AS id,
               t.identifier AS task_identifier,
               ${jobHoldExpr} AS hold,
               j.payload,
               q.queue_name,
               j.priority,
               j.run_at, j.locked_at, j.locked_by,
               j.attempts, j.max_attempts, j.last_error,
               j.created_at, j.updated_at,
               CASE WHEN j.locked_at IS NULL THEN NULL ELSE ${jobLockHeldExpr} END AS alive
          FROM graphile_worker._private_jobs j
          JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
         WHERE ${jobTaskScope}
           AND NOT (j.locked_at IS NULL AND ${supersededExpr})
         ORDER BY j.run_at DESC
         LIMIT ${limit}`,
  });

  // No date conversion: drizzle already handed these back as strings (see the
  // schema header), and the parse has established that. `loadDeadJobsList` below
  // reads through drizzle's typed query builder instead, which maps its
  // `timestamp` columns to `Date` — a third behaviour again, and the one
  // `DeadJobRowSchema` declares.
  const rows = raw.map((r) => ({
    id: r.id,
    jobName: r.payload.jobName ?? "(unknown)",
    hold: r.hold,
    input: r.payload.input ?? null,
    state: deriveState(r),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAt: r.run_at,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    alive: r.alive,
    // Process state, not a column — same reasoning as `queryRunningJobs`. A row
    // this backend never dispatched (or dispatched and finished) reads `false`.
    forfeited: isSlotForfeited(r.id),
    queueName: r.queue_name,
    priority: r.priority,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  const counts = { pending: 0, running: 0, retrying: 0, dead: 0 };
  for (const j of rows) counts[j.state]++;

  return { rows, counts };
}
