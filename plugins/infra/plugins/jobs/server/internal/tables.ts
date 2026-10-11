import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { HoldClassSchema } from "../../core/hold";
import { JobRunOutcomeSchema } from "../../core/resources";

// Step log for durable workflows — memoizes side-effects performed via
// `ctx.step(name, fn)` so replays (retries or resumes after a suspend) skip
// previously-completed work. Row is keyed by (workflowRunId, stepName); the
// name must be unique per handler. Rows for a workflow are deleted on normal
// completion (see worker cleanup).
export const _jobSteps = pgTable(
  "job_steps",
  {
    workflowRunId: text("workflow_run_id").notNull(),
    stepName: text("step_name").notNull(),
    // JSONB so a step that returns `undefined` distinguishes from "not run".
    // `result` is wrapped `{ v: <result> }` so `null` round-trips cleanly — and
    // the box is exactly what the decoder verifies. What is INSIDE it is a step
    // handler's arbitrary return value, so `v` stays `z.unknown()`: the schema
    // claims the wrapper and nothing else, which is all this column ever knew.
    resultJson: parsedJson("result_json", z.object({ v: z.unknown() })),
    // Set when the step threw; replays re-throw the recorded message.
    errorMessage: text("error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.workflowRunId, t.stepName] })],
);

// The wait lifecycle, written once: this schema IS the `status` column's decoder
// and the source of its declared type, so the two cannot drift. Strict rather
// than tolerant — the durable workflow engine is the only writer and has never
// renamed a state, so an unknown value is a bug and should be loud.
const JobWaitStatusSchema = z.enum([
  "pending",
  "resolved",
  "timed_out",
  "cancelled",
]);

// Wait log for durable workflows — tracks each `ctx.waitFor(event, ...)` call
// site. `pending` until either the event fires (→ resolved) or the timeout
// expires (→ timed_out). Payload from the event is stored so replay-after-
// resume can return it without re-running the trigger subscription.
export const _jobWaits = pgTable(
  "job_waits",
  {
    workflowRunId: text("workflow_run_id").notNull(),
    waitName: text("wait_name").notNull(),
    status: parsedText("status", JobWaitStatusSchema).notNull(),
    // Whatever event fired — `waitFor<T>` is generic per call site, so the only
    // claim the column can make is the one `Record<string, unknown>` made and
    // nothing checked: a non-null object. `z.record` keeps every key of it.
    payloadJson: parsedJson("payload_json", z.record(z.string(), z.unknown())),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.workflowRunId, t.waitName] }),
    index("job_waits_status_idx").on(t.status),
  ],
);

// Durable archive of permanently-failed graphile jobs. The graphile queue has
// no GC for jobs that exhausted `max_attempts`, so they accumulate forever in
// every worktree's `_private_jobs`. `reconcileDeadJobs` copies dead rows here
// (idempotently — PK is the original graphile job id), purges them from the
// queue, and bounds this table by TTL + cap. Surfaced in Debug → Queue → Dead.
export const _deadJobs = pgTable(
  "dead_jobs",
  {
    // Original graphile job id — PK makes the archive INSERT idempotent.
    id: text("id").primaryKey(),
    jobName: text("job_name").notNull(),
    // The dead job's original enqueue input — one shape per job type, so this
    // column declares `unknown` and means it. A decoder would have nothing to
    // verify, and every reader already treats it as `unknown`.
    input: jsonb("input"),
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    lastError: text("last_error"),
    diedAt: timestamp("died_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("dead_jobs_archived_at_idx").on(t.archivedAt),
    // `queryRecentDeadJobs` reads the last day of deaths on every queue change
    // (the health row's pulse). Each row carries its job's input inline — one
    // heap page per row on main — so without this a 2000-row archive is a
    // 2000-page scan to find a handful of recent ones.
    index("dead_jobs_died_at_idx").on(t.diedAt),
  ],
);

// How a recorded run ended (`JobRunOutcomeSchema`, core). `suspended` is a
// durable workflow that returned to wait (`ctx.waitFor` / `ctx.sleep`, or a
// supervised job handing its work to a detached child): graphile saw a
// success, but the work is not over — its resumed run records the real verdict
// as a run of its own.

// Run history, part 1: ONE row per job name, the latest run and two counters.
// Bounded by construction — the key is the job name, so the table holds at
// most one row per job this database has ever run. No retention sweep (and no
// jobs → retention cycle). Written from graphile's `job:complete` event (see
// run-stats.ts), never read by the queue itself.
export const _jobRunStats = pgTable("job_run_stats", {
  jobName: text("job_name").primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }).notNull(),
  lastFinishedAt: timestamp("last_finished_at", {
    withTimezone: true,
  }).notNull(),
  lastOutcome: parsedText("last_outcome", JobRunOutcomeSchema).notNull(),
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms").notNull(),
  // Null until the job has succeeded at least once.
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  runs: integer("runs").notNull(),
  failures: integer("failures").notNull(),
});

// Run history, part 2: the last `RECENT_RUNS_RING` runs of each job, as a ring —
// run number `seq` lands in `slot = (seq - 1) % RECENT_RUNS_RING` and overwrites
// whatever run held that slot (the upsert's conflict target is the unique
// (job_name, slot) index). Bounded by construction at ring × job names.
//
// Each run's identity is `id` = `<job_name>:<seq>`, a STORED generated column —
// unique per run, unable to disagree with the two columns it names, and moved
// with them when a slot is overwritten (the change feed names both the old and
// the new id of such an UPDATE). It is the single-column primary key the
// `job-runs` live collection (core/resources.ts) binds to.
//
// Successor of `job_recent_runs` (whose composite (job_name, slot) key no
// collection can bind): the migration that created this table copied that
// ring's rows across before dropping it.
export const _jobRuns = pgTable(
  "job_runs",
  {
    id: text("id")
      .primaryKey()
      .generatedAlwaysAs(
        (): ReturnType<typeof sql> => sql`job_name || ':' || seq::text`,
      ),
    jobName: text("job_name").notNull(),
    slot: integer("slot").notNull(),
    // The run's number (the stats row's `runs` after it was counted) — the
    // ring's order, since a slot says nothing about recency once it wraps.
    seq: integer("seq").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    outcome: parsedText("outcome", JobRunOutcomeSchema).notNull(),
    error: text("error"),
    durationMs: integer("duration_ms").notNull(),
    attempt: integer("attempt").notNull(),
    // NULL on a run copied from `job_recent_runs`, which never recorded them.
    // `job_id` is graphile's row id (text, like `dead_jobs.id`); `hold` the
    // class of the task the row was fetched on; `queued_at` the row's `run_at`
    // — when it became runnable, so `started_at − queued_at` is how long it
    // waited for a slot; `input` the payload's input, one shape per job type,
    // so `unknown` and meant.
    jobId: text("job_id"),
    hold: parsedText("hold", HoldClassSchema),
    maxAttempts: integer("max_attempts"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    input: jsonb("input"),
  },
  (t) => [
    uniqueIndex("job_runs_job_name_slot_idx").on(t.jobName, t.slot),
    // The collection's default order (newest finished first).
    index("job_runs_finished_at_idx").on(t.finishedAt),
  ],
);
