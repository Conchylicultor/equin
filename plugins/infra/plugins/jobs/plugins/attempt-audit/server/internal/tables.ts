import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { parsedJson } from "@plugins/database/plugins/sql-column/server";
import { JobAttemptFailedPayloadSchema } from "../../core";

/**
 * A failed attempt whose run has not settled yet: which report occurrence
 * says it, so the run's outcome can restate it — durably, since the next
 * attempt often runs in another process (a deploy restarted the backend
 * between the two: the 2026-11-05 `worktree.prepare` failure).
 *
 * A row lives from its attempt's report to its run's settle (seconds to
 * minutes); the daily retention sweep bounds what a lost settle leaves.
 */
export const _jobAttemptReports = pgTable(
  "job_attempt_reports",
  {
    /** The queue row (graphile's id; the in-process queue's uuid). */
    jobId: text("job_id").notNull(),
    attempt: integer("attempt").notNull(),
    /** The `job-attempt-failed` report the attempt was filed on. */
    reportId: text("report_id").notNull(),
    /** The occurrence's instant as the report stamped it (epoch ms in
     * `recent`), what a restate matches on. */
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /** The occurrence's payload as filed; its restate swaps only `fate`. */
    data: parsedJson("data", JobAttemptFailedPayloadSchema).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.attempt] })],
);
