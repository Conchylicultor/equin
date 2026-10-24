import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { ALL_JOB_TASKS } from "@plugins/infra/plugins/jobs/server";

// Raw reads of graphile's own tables, shared by the two queue-level endpoints.
//
// The jobs plugin's public introspection (`queryRunningJobs`) is the right read
// for LIVENESS and is used for exactly that — but it says nothing about queues,
// because nothing in the app has needed to ask until now. So the two facts these
// tests are about — which serialization queue a row landed in, and whether that
// queue is locked — are read here, in one place, rather than re-typed per
// endpoint. `crash-recovery.ts` already reaches into `_private_jobs` the same way
// to find the row it just enqueued.

/**
 * Every graphile task identifier an equin job row can sit on, as a SQL list
 * for an `IN (…)`.
 *
 * Composed from the jobs plugin's own `ALL_JOB_TASKS`, never spelled here. Since
 * hold classes landed there is one task per class (`jobs.run.instant` / …) plus
 * the legacy `jobs.run`, so a harness scoping on the single legacy identifier —
 * which is how all three of these queries were written — silently matches NO
 * rows at all, and every assertion built on it reads an empty set as a pass.
 */
export const jobTaskList = drizzleSql.join(
  ALL_JOB_TASKS.map((task) => drizzleSql`${task}`),
  drizzleSql`, `,
);

/** One `events_test.serial` row, plus the queue it was filed under. */
export interface SerialJobRow {
  jobId: string;
  label: string;
  /** `locked_at IS NOT NULL` — graphile handed this row to a worker, so it is
   * holding a slot from the shared pool. The whole point of `serial` is that the
   * rows waiting behind a busy queue are NOT in this state. */
  locked: boolean;
  /** NULL here is the silent failure `serial` is meant to prevent: a row with no
   * queue is fetched regardless of who else is running. */
  queueId: string | null;
  queueName: string | null;
  queueLocked: boolean;
}

const SerialJobRowSqlSchema = z.object({
  job_id: z.string(),
  // `->>` can yield NULL, but every row this harness enqueues carries a label —
  // so `z.string()` is the assertion, and a missing one is now a loud failure
  // rather than a `null` flowing into a `string`-typed field.
  label: z.string(),
  locked: z.boolean(),
  // Both nullable through the LEFT JOIN: a row outside a `serial` lane has no
  // `q` row (and `NULL IS NOT NULL` is still `false`, so `queue_locked` is not).
  queue_id: z.string().nullable(),
  queue_name: z.string().nullable(),
  queue_locked: z.boolean(),
});

/** Every row this harness invocation enqueued, oldest first. Scoped by the
 * `run` field the test bakes into each payload, so two concurrent invocations
 * (or a leftover row from an earlier one) cannot be mistaken for each other. */
export async function readSerialRows(run: string): Promise<SerialJobRow[]> {
  const rows = await executeRows(db, {
    label: "queue-probe: serial rows",
    row: SerialJobRowSqlSchema,
    query: drizzleSql`
    SELECT j.id::text                    AS job_id,
           j.payload->'input'->>'label'  AS label,
           (j.locked_at IS NOT NULL)     AS locked,
           j.job_queue_id::text          AS queue_id,
           q.queue_name                  AS queue_name,
           (q.locked_at IS NOT NULL)     AS queue_locked
      FROM graphile_worker._private_jobs j
      LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
     WHERE j.task_id IN (
             SELECT id FROM graphile_worker._private_tasks
              WHERE identifier IN (${jobTaskList})
           )
       AND j.payload->'input'->>'run' = ${run}
     ORDER BY j.id
  `,
  });
  return rows.map((r) => ({
    jobId: r.job_id,
    label: r.label,
    locked: r.locked,
    queueId: r.queue_id,
    queueName: r.queue_name,
    queueLocked: r.queue_locked,
  }));
}

export interface QueueLockState {
  queueName: string;
  locked: boolean;
  lockedBy: string | null;
}

/** The lock state of one `_private_job_queues` row. Read separately from the job
 * rows because the queue outlives them: after a job completes graphile deletes
 * its row but keeps the queue. */
export async function readQueueLock(
  queueId: string,
): Promise<QueueLockState | null> {
  // Zero or one row — the queue may simply not exist — so `executeRows` and an
  // explicit "not found", never `executeOne`.
  const rows = await executeRows(db, {
    label: "queue-probe: queue lock",
    row: z.object({
      queue_name: z.string(),
      locked: z.boolean(),
      locked_by: z.string().nullable(),
    }),
    query: drizzleSql`
    SELECT q.queue_name                AS queue_name,
           (q.locked_at IS NOT NULL)   AS locked,
           q.locked_by                 AS locked_by
      FROM graphile_worker._private_job_queues q
     WHERE q.id = ${queueId}::int
  `,
  });
  const row = rows[0];
  if (!row) return null;
  return {
    queueName: row.queue_name,
    locked: row.locked,
    lockedBy: row.locked_by,
  };
}

/** A fixed wait, used only where the assertion is that something does NOT
 * happen — there is no event to wait for, so the settle window IS the test. */
export function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Same shape as `crash-recovery.ts`: the first failed assertion is reported as
 * a named step rather than thrown, so a failing run reads as a verdict. */
export function fail(
  step: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { ok: false, step, error: detail, ...extra },
    { status: 500 },
  );
}
