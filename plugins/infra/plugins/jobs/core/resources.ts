import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { HoldClassSchema } from "./hold";

export const JobStateSchema = z.enum([
  "pending",
  "running",
  "retrying",
  "dead",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobRowSchema = z.object({
  id: z.string(),
  jobName: z.string(),
  /**
   * The row's duration class — which tier of the runner ladder can fetch it.
   * Derived from the graphile task the row sits on, not from the payload.
   *
   * OPTIONAL on purpose, and it must stay that way. During a rolling restart a
   * client can still be holding a live-state payload produced by a backend from
   * before hold classes existed; making this required would fail that parse and
   * blank the Debug → Queue pane for the length of the deploy.
   */
  hold: HoldClassSchema.optional(),
  input: z.unknown(),
  state: JobStateSchema,
  attempts: z.number(),
  maxAttempts: z.number(),
  runAt: z.string(),
  lockedAt: z.string().nullable(),
  lockedBy: z.string().nullable(),
  // Exact worker liveness for a `running` row: `true` = a worker still holds the
  // job's session-scoped advisory lock, `false` = nobody does (the owning backend
  // died, or dispatch is mid-acquisition). `null` for every non-running row,
  // where the question is meaningless. Never derive this from how long
  // `lockedAt` has been set — that inference is the bug this replaced.
  alive: z.boolean().nullable(),
  /**
   * Whether the backend has WRITTEN OFF the slot this run is holding: it passed
   * its hold class's deadline, ignored the abort, and outlived the zombie
   * grace. `alive && forfeited` is the wedge — the handler is still running and
   * nobody is waiting for it any more.
   *
   * OPTIONAL for the same reason `hold` is, and it must stay that way: during a
   * rolling restart a client can still hold a payload produced by a backend
   * from before forfeit existed, and making this required would fail that parse
   * and blank the Debug → Queue pane for the length of the deploy.
   */
  forfeited: z.boolean().optional(),
  queueName: z.string().nullable(),
  priority: z.number(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobRow = z.infer<typeof JobRowSchema>;

export const JobsPayloadSchema = z.object({
  rows: z.array(JobRowSchema),
  counts: z.object({
    pending: z.number(),
    running: z.number(),
    retrying: z.number(),
    dead: z.number(),
  }),
});
export type JobsPayload = z.infer<typeof JobsPayloadSchema>;

/**
 * Debug → Queue's Jobs tab: the newest 500 graphile job rows, with their
 * per-state counts. Served external (`server/internal/resources.ts`): graphile's
 * tables sit outside the schema the change feed covers.
 *
 * `load: "on-demand"`: a 500-row join read by one Debug pane is kept out of the
 * shared flush — a change sends an `invalidate`, and each open tab refetches
 * over HTTP. No placeholder: not loaded yet is `pending`, never an empty queue.
 */
export const jobsList = liveValue("jobs-list", {
  schema: JobsPayloadSchema,
  load: "on-demand",
});

// ─── Dead-letter archive (see server/internal/dead-job-gc.ts) ──────────────

// The fields of an archived `dead_jobs` row, field for column: the `deadJobs`
// collection binds each to its column by name. The two timestamps are coerced
// Dates — a `timestamp` column reads back as a `Date` through drizzle's query
// builder, and crosses the wire as an ISO string. The labelled ones are what
// the Dead tab shows (in its order); the rest ride on the row.
const DEAD_JOB_FIELDS = {
  id: textField(),
  input: nullable(jsonField({ schema: z.unknown(), default: null })),
  maxAttempts: intField(),
  jobName: textField({ label: "Job", primary: true }),
  attempts: intField({ label: "Attempts" }),
  diedAt: nullable(dateField({ label: "Died" })),
  lastError: nullable(textField({ label: "Last error" })),
  archivedAt: dateField({ label: "Archived" }),
};

/**
 * The `dead_jobs` entity — the dead-letter archive, one row per job graphile
 * gave up on (a copy of its `_private_jobs` row; `id` is graphile's job id).
 * The table is built from these fields (`server/internal/tables.ts`).
 */
export const deadJobsEntityRef = entityRef("dead_jobs", DEAD_JOB_FIELDS);
export const DeadJobRowSchema = fieldsToZodObject(DEAD_JOB_FIELDS);
export type DeadJobRow = z.infer<typeof DeadJobRowSchema>;

// The `GET /api/jobs/dead` endpoint's body. The live collection below carries
// the bare rows.
export const DeadJobsPayloadSchema = z.object({
  rows: z.array(DeadJobRowSchema),
});
export type DeadJobsPayload = z.infer<typeof DeadJobsPayloadSchema>;

/**
 * How many rows the dead-letter archive keeps: the dead-job GC trims
 * `dead_jobs` to the newest this-many on every reconcile
 * (`server/internal/dead-job-gc.ts`), and a window of the `deadJobs`
 * collection grows to at most the same — so a fully grown window is the whole
 * archive.
 */
export const DEAD_JOBS_ARCHIVE_CAP = 2000;

/**
 * Debug → Queue's Dead tab: the dead-letter archive as a live collection — a
 * bounded window, newest archived first (200, grown to at most
 * `DEAD_JOBS_ARCHIVE_CAP`), plus its `:rows` / `:groups` siblings. It backs
 * a live DataView (key-range pages): search runs over `jobName` /
 * `lastError`, `jobName` is a facet (a `:groups` grouping of the whole
 * archive), and `attempts` / `diedAt` / `archivedAt` filter and sort. The
 * archive is trimmed to `DEAD_JOBS_ARCHIVE_CAP` rows, so a `contains` over
 * `lastError` scans at most that many. No poll and no notify: `dead_jobs` is a
 * public table, so the change feed moves every subscribed window when the
 * dead-job GC archives or purges.
 */
export const deadJobs = liveCollection("dead-jobs", {
  from: deadJobsEntityRef,
  pick: ["jobName", "attempts", "diedAt", "lastError", "archivedAt"],
  carry: { pick: ["id", "input", "maxAttempts"] },
  id: "id",
  sortable: ["archivedAt", "diedAt", "jobName", "attempts"],
  default: { orderBy: [["archivedAt", "desc"]], limit: 200 },
  maxLimit: DEAD_JOBS_ARCHIVE_CAP,
});

/** A row of the {@link deadJobs} collection: the archived job, plus the fields an extension exposes on the entity. */
export type DeadJobListRow =
  typeof deadJobs extends LiveRowsCollection<infer R> ? R : never;

// ─── Run history (see server/internal/run-stats.ts) ────────────────────────

/** How a recorded run ended — `suspended` is a durable workflow that returned to wait. */
export const JobRunOutcomeSchema = z.enum(["succeeded", "failed", "suspended"]);
export type JobRunOutcome = z.infer<typeof JobRunOutcomeSchema>;

const JOB_RUN_OUTCOME = parsedTextField(JobRunOutcomeSchema, {
  default: "succeeded",
});
const JOB_RUN_HOLD = nullable(
  parsedTextField(HoldClassSchema, { default: "instant" }),
);

/**
 * The `job_runs` entity — the per-job ring of recent runs, column for column
 * (`server/internal/tables.ts` builds the table from it). `slot` is the ring
 * slot a run landed in; `id` is generated from `job_name` and `seq`.
 *
 * `id` is `<jobName>:<seq>` — `seq` the job's run number. `jobId`, `hold`,
 * `maxAttempts`, `queuedAt` and `input` are NULL on a run recorded before the
 * history kept them. `error` is the error's message (up to 8000 chars), set
 * exactly when `outcome` is `failed`.
 */
export const jobRunsEntityRef = entityRef("job_runs", {
  id: textField(),
  jobName: textField({ label: "Job" }),
  slot: intField(),
  seq: intField({ label: "Run" }),
  startedAt: dateField({ label: "Started" }),
  finishedAt: dateField({ label: "Finished" }),
  outcome: JOB_RUN_OUTCOME,
  error: nullable(textField({ label: "Error" })),
  durationMs: intField({ label: "Duration" }),
  attempt: intField({ label: "Attempt" }),
  jobId: nullable(textField()),
  hold: JOB_RUN_HOLD,
  maxAttempts: nullable(intField({ label: "Max attempts" })),
  queuedAt: nullable(dateField({ label: "Queued" })),
  input: nullable(jsonField({ schema: z.unknown(), default: null })),
});

// The run fields the collection declares itself: the counters its wire reads as
// floats where the entity stores integers, and `waitMs`, which is not stored.
const JOB_RUN_OWN = {
  seq: floatField(),
  durationMs: floatField(),
  /** Which attempt this run was (1-based; graphile's `attempts` after the run started). */
  attempt: floatField(),
  maxAttempts: nullable(floatField()),
  /**
   * How long the run waited for a worker slot: `startedAt − queuedAt` in ms,
   * floored at 0 (the two come from different clocks). Not a stored column —
   * the served collection computes it in SQL. NULL when `queuedAt` is.
   */
  waitMs: nullable(floatField()),
};

/**
 * Debug → Queue's run history: EVERY recorded run, as the whole ordered set
 * (`all`, newest finished first) plus its `:rows` point sibling. Its one
 * reader, the Jobs list, merges it with the live graphile queue on the client
 * and filters, sorts and groups the merge there — so it needs every run, and a
 * window would silently drop the oldest past its edge. Bounded by the table: a
 * per-job ring of `RECENT_RUNS_RING` (20) runs (server/internal/tables.ts), so
 * 20 × (job names ever run) rows — about 1,800 on main. No poll and no notify:
 * `job_runs` is a public table, so the change feed routes each finished run's
 * write (an insert, or an overwrite of the ring slot it lands in) to the set.
 *
 * The key is `job-runs.all`, not the old window's `job-runs`: no bundle ever
 * declared this key with another contract, so a tab on an older one gets
 * `unknown-key` (a `skew` verdict) and never parses these rows.
 */
export const jobRuns = liveCollection("job-runs.all", {
  from: jobRunsEntityRef,
  carry: {
    pick: [
      "id",
      "jobName",
      "startedAt",
      "finishedAt",
      "outcome",
      "error",
      "jobId",
      "hold",
      "queuedAt",
      "input",
    ],
    fields: JOB_RUN_OWN,
  },
  id: "id",
  all: {
    orderBy: [["finishedAt", "desc"]],
    unbounded: {
      reason:
        "a ring of 20 per job name, and the Jobs list merges and filters every run on the client",
    },
  },
});

/** One recorded run of a job: a row of `job_runs`, plus the derived `waitMs`. */
export type JobRunRow =
  typeof jobRuns extends LiveRowsCollection<infer R> ? R : never;
