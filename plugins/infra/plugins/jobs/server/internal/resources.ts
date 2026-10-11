import { desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  deadJobs,
  jobRuns,
  jobsList,
  type DeadJobsPayload,
  type JobsPayload,
  type JobState,
} from "../../core/resources";
import { HoldClassSchema } from "../../core/hold";
import {
  jobHoldExpr,
  jobLockHeldExpr,
  jobTaskScope,
  supersededExpr,
} from "./introspection";
import { isSlotForfeited } from "./forfeit";
import { onQueueActivity } from "./slot-ledger";
import { _deadJobs, _jobRuns } from "./tables";

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

// The `GET /api/jobs/dead` read. Rows verbatim: `DeadJobRowSchema` is the
// table's columns, timestamps as `Date`. Debug → Queue reads the `dead-jobs`
// collection instead (`deadJobsServed` below).
export async function loadDeadJobsList(limit = 2000): Promise<DeadJobsPayload> {
  const rows = await db
    .select()
    .from(_deadJobs)
    .orderBy(desc(_deadJobs.archivedAt))
    .limit(limit);
  return { rows };
}

// The dead-letter archive over `dead_jobs`: its window (newest archived first)
// and its `:rows` / `:groups` siblings, every column bound by name. No poll and
// no notify — the change feed covers `dead_jobs`, so the GC's archive insert
// and its TTL / cap purge move every subscribed window. A row is written once
// and never updated, so `archivedAt` never re-sorts one.
export const deadJobsServed = serveCollection(deadJobs, { from: _deadJobs });

// The run history over `job_runs` (a per-job ring, see tables.ts): its scroll
// window (newest finished first), its `:rows` point sibling and the `:groups`
// the facets read. Every stored field binds to its column by name; `waitMs` is
// the one computed field — `started_at − queued_at` in whole ms, floored at 0
// because `started_at` is this process's clock and `queued_at` the database's.
// No poll and no notify: the change feed covers `job_runs`. A run's write is
// an insert, or an UPDATE of the ring slot it overwrites — which moves the
// row's generated `id`, and the feed names both the old and the new one, so
// the overwritten run leaves every window it was in.
export const jobRunsServed = serveCollection(jobRuns, {
  from: _jobRuns,
  columns: {
    waitMs: (j) =>
      expr(
        // GREATEST skips NULLs, so the CASE keeps a run with no `queued_at`
        // NULL rather than reading it as a 0 ms wait.
        sql`CASE WHEN ${j.base.queuedAt} IS NULL THEN NULL ELSE GREATEST(0, round(EXTRACT(EPOCH FROM (${j.base.startedAt} - ${j.base.queuedAt})) * 1000))::integer END`,
        {
          decoder: parsed(z.number().int(), "job-runs.waitMs"),
          sqlType: "integer",
        },
      ),
  },
});

// `jobs-list` reads the `graphile_worker.*` job tables, which live OUTSIDE the
// public schema the L4 DB change-feed triggers cover (the feed deliberately
// excludes the graphile_worker schema) — so the feed can NEVER invalidate this
// value. It is therefore served external (`source: "external"`, the arm with a
// `notify`), driven by the slot ledger's queue activity signal (slot-ledger.ts):
// graphile's own `job:start` / `job:complete` events on every runner, its
// `jobs:insert` notification, and this plugin's own mutations that send none
// (retry, cancel, dead-job GC, the stuck-lock reclaim). It listens only while a
// tab is subscribed: `whileSubscribed` hands the signal this value's `notify`,
// and the listener's remover is the stop.
//
// It used to re-read up to 500 rows every 3 s while observed, because those
// lifecycle transitions happened "inside a runner we can't hook". We can: we
// create the runners, and each has its own event emitter.
//
// `throttleMs`: a burst of activity (a fan-out enqueue, a queue draining) costs
// one reload per second, not one per event. Inserts are heard from any process
// (they arrive over LISTEN); what this cannot see is a job started or finished
// by runners in ANOTHER process against the same database.
export const jobsListServed = serveValue(jobsList, {
  source: "external",
  loader: () => loadJobsList(500),
  throttleMs: 1000,
  whileSubscribed: (_params, notify) => onQueueActivity(notify),
});
