import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { durationField } from "@plugins/fields/plugins/duration/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { identifierField } from "@plugins/fields/plugins/identifier/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { HOLD_CLASSES, HoldClassSchema } from "./hold";

export const JOB_STATES = ["pending", "running", "retrying", "dead"] as const;
export const JobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobStateSchema>;

// ─── The live queue (see server/internal/resources.ts) ─────────────────────

// The fields of one queue row. The labelled ones are what Debug → Queue lists
// and filters (in its order); the rest ride on the row for its detail pane.
// Every instant is the row's `timestamptz` cut to ms (what a `Date` holds).
const JOB_FIELDS = {
  jobName: textField({ label: "Job", primary: true }),
  state: enumTextField(JOB_STATES, { label: "Status" }),
  /**
   * The row's duration class — which tier of the runner ladder can fetch it.
   * Derived from the graphile task the row sits on, not from the payload.
   */
  hold: nullable(enumTextField(HOLD_CLASSES, { label: "Hold" })),
  attempts: intField({ label: "Attempts" }),
  /** When the row becomes runnable (a retrying row: when its backoff ends). */
  runAt: dateField({ label: "Run at" }),
  lastError: nullable(textField({ label: "Last error" })),
};

const JOB_CARRIED = {
  /** graphile's job id (a bigint), as text. */
  id: textField(),
  input: nullable(jsonField({ schema: z.unknown() })),
  maxAttempts: intField(),
  lockedAt: nullable(dateField()),
  lockedBy: nullable(textField()),
  /**
   * Exact worker liveness for a `running` row: `true` = a worker still holds
   * the job's session-scoped advisory lock, `false` = nobody does (the owning
   * backend died, or dispatch is mid-acquisition). `null` for every
   * non-running row, where the question is meaningless. Never derive this from
   * how long `lockedAt` has been set — that inference is the bug this replaced.
   */
  alive: nullable(boolField()),
  /**
   * Whether the backend has WRITTEN OFF the slot this run is holding: it
   * passed its hold class's deadline, ignored the abort, and outlived the
   * zombie grace. `alive && forfeited` is the wedge — the handler is still
   * running and nobody is waiting for it any more.
   */
  forfeited: boolField(),
  queueName: nullable(textField()),
  priority: intField(),
  createdAt: dateField(),
  updatedAt: dateField(),
};

/** How many queue rows one window of {@link jobs} holds at most. */
export const JOBS_MAX_LIMIT = 500;

/**
 * Debug → Queue's Queue view: the host's job queue (on the desktop graphile's
 * `_private_jobs`, in the browser the in-memory queue) as a live window
 * collection — newest `runAt` first, cut on `(runAt, id)` — plus its
 * `:rows` / `:groups` / `:count` siblings. Served external
 * (`server/internal/resources.ts`): graphile's tables sit outside the schema
 * the change feed covers, so the queue's own activity signal notifies it. A
 * row leaves when its run finishes; the run is then a row of {@link jobRuns}.
 *
 * `runAt` is the one sort: the queue's keyset is `(runAt, id)` — an instant cut
 * to ms, then graphile's id as TEXT (the `$key` order) — and an unlocked
 * superseded row (retired, a newer copy queued) is never listed.
 */
export const jobs = liveCollection("jobs", {
  fields: JOB_FIELDS,
  carry: { fields: JOB_CARRIED },
  id: "id",
  sortable: ["runAt"],
  default: { orderBy: [["runAt", "desc"]], limit: 100 },
  maxLimit: JOBS_MAX_LIMIT,
  count: true,
});

/** One queue row: a row of the {@link jobs} collection. */
export type JobRow =
  typeof jobs extends LiveRowsCollection<infer R> ? R : never;

/**
 * A queue row's `runAt` as its `$key` text — `Date#toISOString()`, which a
 * source cuts to ms like the row's value (a fixed-width UTC instant, so its
 * code-point order is time order). Every queue implementation orders and cuts
 * on exactly this text, then the id.
 */
export function jobRunAtKeyText(runAt: Date): string {
  return runAt.toISOString();
}

// ─── Dead-letter archive (see server/internal/dead-job-gc.ts) ──────────────

// The fields of an archived `dead_jobs` row, field for column: the `deadJobs`
// collection binds each to its column by name. The two timestamps are coerced
// Dates — a `timestamp` column reads back as a `Date` through drizzle's query
// builder, and crosses the wire as an ISO string. The labelled ones are what
// the Dead tab shows (in its order); the rest ride on the row.
const DEAD_JOB_FIELDS = {
  id: textField(),
  input: nullable(jsonField({ schema: z.unknown() })),
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
  label: "Outcome",
});
const JOB_RUN_HOLD = nullable(
  parsedTextField(HoldClassSchema, { default: "instant", label: "Hold" }),
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
  durationMs: durationField({ label: "Duration" }),
  attempt: intField({ label: "Attempt" }),
  jobId: nullable(identifierField({ label: "Job id" })),
  hold: JOB_RUN_HOLD,
  maxAttempts: nullable(intField({ label: "Max attempts" })),
  queuedAt: nullable(dateField({ label: "Queued" })),
  input: nullable(jsonField({ schema: z.unknown() })),
});

// The run fields the collection declares itself: `waitMs`, which is not
// stored (listed), and the counters its wire reads as floats where the entity
// stores integers (carried).
const JOB_RUN_LISTED = {
  /**
   * How long the run waited for a worker slot: `startedAt − queuedAt` in ms,
   * floored at 0 (the two come from different clocks). Not a stored column —
   * the served collection computes it in SQL. NULL when `queuedAt` is.
   */
  waitMs: nullable(durationField({ label: "Waited" })),
};
const JOB_RUN_CARRIED = {
  seq: floatField(),
  maxAttempts: nullable(floatField()),
};

/** How many runs one window of {@link jobRuns} holds at most. */
export const JOB_RUNS_MAX_LIMIT = 1000;

/**
 * Debug → Queue's History view: the recorded runs (`job_runs`, a per-job ring
 * of `RECENT_RUNS_RING` (20) runs — server/internal/tables.ts) as a live
 * window collection, newest finished first, plus its `:rows` / `:groups` /
 * `:count` siblings. A job's queue row (see {@link jobs}) becomes a row here
 * when its run finishes. `jobName` / `outcome` / `hold` filter, group and
 * facet; `finishedAt` / `durationMs` / `waitMs` sort; `jobId` names the queue
 * row a run came from (what a detail pane follows a finished job by). No poll
 * and no notify: `job_runs` is a public table, so the change feed routes each
 * finished run's write (an insert, or an overwrite of the ring slot it lands
 * in) to the windows it reaches.
 *
 * The key is `job-runs.history`, not the old whole-set `job-runs.all` nor the
 * older window's `job-runs`: a tab on an older bundle gets `unknown-key` (a
 * `skew` verdict) and never parses these rows.
 */
export const jobRuns = liveCollection("job-runs.history", {
  from: jobRunsEntityRef,
  pick: [
    "jobName",
    "outcome",
    "hold",
    "attempt",
    "finishedAt",
    "durationMs",
    "error",
    "jobId",
  ],
  fields: JOB_RUN_LISTED,
  carry: {
    pick: ["id", "startedAt", "queuedAt", "input"],
    fields: JOB_RUN_CARRIED,
  },
  id: "id",
  sortable: ["finishedAt", "durationMs", "waitMs"],
  default: { orderBy: [["finishedAt", "desc"]], limit: 100 },
  maxLimit: JOB_RUNS_MAX_LIMIT,
  count: true,
});

/** One recorded run of a job: a row of `job_runs`, plus the derived `waitMs`. */
export type JobRunRow =
  typeof jobRuns extends LiveRowsCollection<infer R> ? R : never;
