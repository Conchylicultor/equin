import { desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
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
} from "../../core/resources";
import { JobQueue } from "./queue";
import { _deadJobs, _jobRuns } from "./tables";

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

// The run history over `job_runs` (a per-job ring, see tables.ts): the whole
// ordered set (newest finished first) and its `:rows` point sibling. Every
// stored field binds to its column by name; `waitMs` is the one computed field
// — `started_at − queued_at` in whole ms, floored at 0 because `started_at` is
// this process's clock and `queued_at` the database's. No poll and no notify:
// the change feed covers `job_runs`. A run's write is an insert, or an UPDATE
// of the ring slot it overwrites — which moves the row's generated `id`, and
// the feed names both the old and the new one, so the overwritten run leaves
// the set as the new one enters it.
export const jobRunsServed = serveCollection(jobRuns, {
  from: _jobRuns,
  columns: { waitMs: (j) => jobRunWaitMs(j.base) },
});

/** `waitMs` over a `job_runs` row's two instants, as SQL (see above). */
export function jobRunWaitMs(run: { startedAt: unknown; queuedAt: unknown }) {
  return expr(
    // GREATEST skips NULLs, so the CASE keeps a run with no `queued_at` NULL
    // rather than reading it as a 0 ms wait.
    sql`CASE WHEN ${run.queuedAt} IS NULL THEN NULL ELSE GREATEST(0, round(EXTRACT(EPOCH FROM (${run.startedAt} - ${run.queuedAt})) * 1000))::integer END`,
    {
      decoder: parsed(z.number().int(), "job-runs.waitMs"),
      sqlType: "integer",
    },
  );
}

// `jobs-list` is the host queue's own rows (`JobQueue.list`) — on the desktop
// graphile's `graphile_worker.*` job tables, which live OUTSIDE the public
// schema the L4 DB change-feed triggers cover (the feed deliberately excludes
// the graphile_worker schema) — so the feed can NEVER invalidate this value. It
// is therefore served external (`source: "external"`, the arm with a
// `notify`), driven by the queue's activity signal (`JobQueue.onActivity`: on
// the desktop the slot ledger's — graphile's own `job:start` / `job:complete`
// events on every runner, its `jobs:insert` notification, and this plugin's own
// mutations that send none). It listens only while a tab is subscribed:
// `whileSubscribed` hands the signal this value's `notify`, and the listener's
// remover is the stop.
//
// `throttleMs`: a burst of activity (a fan-out enqueue, a queue draining) costs
// one reload per second, not one per event.
export const jobsListServed = serveValue(jobsList, {
  source: "external",
  changes: "notified",
  loader: () => JobQueue.get().list(500),
  throttleMs: 1000,
  whileSubscribed: (_params, notify) => JobQueue.get().onActivity(notify),
});
