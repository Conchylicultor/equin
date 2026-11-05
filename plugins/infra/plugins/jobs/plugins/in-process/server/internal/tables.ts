import { z } from "zod";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { HoldClassSchema } from "@plugins/infra/plugins/jobs/core";
import { externalIdColumn } from "@plugins/ids/server";

// `JobTaskPayload` (infra/jobs), as a decoder.
const JobTaskPayloadSchema = z.object({
  jobName: z.string(),
  workflowRunId: z.string().optional(),
  input: z.unknown(),
  event: z.unknown().optional(),
  _cron: z
    .object({ ts: z.string(), backfilled: z.boolean().optional() })
    .optional(),
});

// The in-process queue's rows, in the database the host's writes go to — as
// graphile keeps the desktop's — so a job outlives the worker that queued it
// and a transaction's enqueue commits or rolls back with the caller's writes.
// Declared here, the one migration history creates them in every database; only
// a host running this queue (a browser host, the portable boot test) writes
// them, so they stay empty on the desktop.

/** A queued row: what the queue needs to run it again after a reload. */
export const _inProcessJobRows = pgTable(
  "jobs_in_process_rows",
  {
    id: externalIdColumn("id", {
      reason:
        "The JobQueue contract's opaque row id (a uuid this queue mints, where the desktop has graphile's bigint) — never reused, since a durable run's step and wait logs are keyed by it.",
    }),
    jobName: text("job_name").notNull(),
    // The job's hold class when it was queued (graphile's task), so a row
    // reads the same in Debug → Queue whether or not its job is still defined.
    hold: parsedText("hold", HoldClassSchema).notNull(),
    // The task payload stored verbatim: the envelope is decoded, a job's input
    // and event are whatever its schemas took.
    payload: parsedJson("payload", JobTaskPayloadSchema).notNull(),
    jobKey: text("job_key"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    dead: boolean("dead").notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // When the queue last changed the row (attempt, retry, collapse) — stamped
    // by the queue on each of its writes, read back as the row's `updatedAt`.
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("jobs_in_process_rows_job_key_idx").on(t.jobKey)],
);

/**
 * When each scheduled job last ticked: the watermark a missed tick is caught
 * up from (`catchUpWithinMs`), as graphile's `known_crontabs.last_execution`.
 */
export const _inProcessJobSchedules = pgTable("jobs_in_process_schedules", {
  jobName: text("job_name").primaryKey(),
  lastExecution: timestamp("last_execution", { withTimezone: true }).notNull(),
});
