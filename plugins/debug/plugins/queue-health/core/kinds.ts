import { z } from "zod";
import { HoldClassSchema } from "@plugins/infra/plugins/jobs/core";

// The per-class occupancy snapshot carried by the wedge and class-starvation
// reports. `reachableSlots` is the ladder's own number for this class (8 / 6 /
// 4) — read from the jobs class table, never restated here.
//
// `lockedCount` is how many LOCKED ROWS of this class exist, which is NOT the
// same as "how many slots this tier is holding": three runners share one
// `_private_jobs` table and graphile records no runner id per row, so the DB
// cannot say which runner holds a given row. Reading it as "rows of this class
// currently running" is exact; reading it as per-runner saturation would not be.
const ClassOccupancySchema = z.object({
  hold: HoldClassSchema,
  reachableSlots: z.number().int(),
  readyCount: z.number().int(),
  lockedCount: z.number().int(),
});

// The jsonb payload for a `queue-dead-job` report. One report per (jobName,
// cause) — the cause being `lastError` normalized (`deadJobFingerprint`) — so
// the payload carries that group's rollup: how many terminally-dead rows, the
// attempt counters, the error text, and a sample graphile job id for
// hand-inspection in the queue pane.
export const QueueDeadJobPayloadSchema = z.object({
  jobName: z.string(),
  deadCount: z.number().int(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.string().nullable(),
  sampleJobId: z.string().nullable(),
});
export type QueueDeadJobPayload = z.infer<typeof QueueDeadJobPayloadSchema>;

// The top-N per-jobName ready-queue attribution, shared verbatim by the backlog
// rollup, the wedge report and the class-starvation report — all three answer
// "who is waiting behind this" from the same `queryBacklogByJobName()` rows, so
// they carry the same shape. `hold` is optional: reports stored before hold
// classes existed still parse.
const TopReadySchema = z.array(
  z.object({
    jobName: z.string(),
    hold: HoldClassSchema.optional(),
    readyCount: z.number().int(),
    oldestOverdueMs: z.number().int(),
  }),
);

// The jsonb payload for the singleton `queue-backlog` rollup report. Carries the
// aggregate snapshot that tripped the threshold: how many ready jobs are
// waiting, how overdue the oldest one is, how many are currently locked (running),
// and whether the worker is making no progress (stalled). `topReady` attributes
// the ready backlog to the jobs filling it — OPTIONAL so already-stored reports
// (filed before this field existed) still parse.
export const QueueBacklogPayloadSchema = z.object({
  readyCount: z.number().int(),
  oldestOverdueMs: z.number().int(),
  lockedCount: z.number().int(),
  stalled: z.boolean(),
  topReady: TopReadySchema.optional(),
});
export type QueueBacklogPayload = z.infer<typeof QueueBacklogPayloadSchema>;

// The jsonb payload for a `queue-slot-hog` report. One report per distinct
// `jobName` (fingerprint `queue-slot-hog:<jobName>`), naming a job that has held
// a worker slot from the shared pool longer than the configured threshold —
// starving the queue even while `lockedCount > 0` (the exact wedge the backlog
// `stalled` signal, which only trips at `lockedCount === 0`, cannot see).
//
// `hold` / `thresholdMs` are OPTIONAL so reports filed before hold classes
// existed still parse. `thresholdMs` is carried rather than recomputed at render
// time because it is `deadlineMsFor(hold) × slotHogDeadlineFraction` at the
// moment of the trip — a later config edit must not silently rewrite what the
// report claimed.
//
// That fraction is constrained strictly below 1, so this report always precedes
// the deadline that aborts the run. A job that reached `job-deadline-exceeded`
// therefore has one of these sitting beside it.
export const QueueSlotHogPayloadSchema = z.object({
  jobName: z.string(),
  hold: HoldClassSchema.optional(),
  thresholdMs: z.number().int().optional(),
  lockedForMs: z.number().int(),
  runningCount: z.number().int(),
  sampleJobId: z.string().nullable(),
});
export type QueueSlotHogPayload = z.infer<typeof QueueSlotHogPayloadSchema>;

// The jsonb payload for a `queue-slot-blocked` report: a job that holds a worker
// slot to WAIT rather than to work. One report per distinct `jobName`.
//
// Every duration here is a PER-RUN AVERAGE over the runs that completed in the
// measurement window (`windowMs`), because that is what the runtime profiler's
// cumulative aggregates can answer exactly: `holdMs` is the span's wall clock,
// `waitMs` the union of admission-gate waits charged inside it, and
// `workMs = holdMs − waitMs` the job's own time. `layer`/`layerMs` name the
// single gate that contributed the most of that wait; `layers` carries the rest.
export const QueueSlotBlockedPayloadSchema = z.object({
  jobName: z.string(),
  runs: z.number().int(),
  windowMs: z.number().int(),
  holdMs: z.number().int(),
  waitMs: z.number().int(),
  workMs: z.number().int(),
  layer: z.string(),
  layerMs: z.number().int(),
  layers: z.array(z.object({ layer: z.string(), ms: z.number().int() })),
});
export type QueueSlotBlockedPayload = z.infer<
  typeof QueueSlotBlockedPayloadSchema
>;

// The jsonb payload for a `queue-class-starved` report: ONE hold class of the
// runner ladder has ready work whose head has not moved for the whole window —
// nothing in that class drained. One rolling report per class per worktree.
//
// `windowMs` is the class's own starvation window (the longer of `wedgeMinutes`
// and the class's work ceiling), carried so the report states the bar it cleared
// rather than leaving a reader to guess which of the two applied.
export const QueueClassStarvedPayloadSchema = z.object({
  hold: HoldClassSchema,
  reachableSlots: z.number().int(),
  readyCount: z.number().int(),
  lockedCount: z.number().int(),
  oldestOverdueMs: z.number().int(),
  starvedForMs: z.number().int(),
  windowMs: z.number().int(),
  classes: z.array(ClassOccupancySchema).optional(),
  topReady: TopReadySchema.optional(),
});
export type QueueClassStarvedPayload = z.infer<
  typeof QueueClassStarvedPayloadSchema
>;

// The jsonb payload for a `queue-wedged` report — the queue has STOPPED
// DRAINING, which is a different claim from either of the two above.
// `queue-backlog` says the queue is deep and `queue-slot-hog` says one job is
// slow; both are routinely true and benign (the nightly `backup.run` trips
// slot-hog every night). This one only fires when every slot is held by the
// SAME live jobs across consecutive samples while ready work waits — nothing is
// completing, so nothing behind it will ever start.
//
// `heldForMs` is the minimum `lockedForMs` across the holders — i.e. every slot
// has been held at least this long. Read off graphile's `locked_at`, NOT off how
// long the watchdog has been watching: a backend that boots into an
// already-wedged queue must report the true 14 minutes, not the 3 it has been
// awake for.
export const QueueWedgedPayloadSchema = z.object({
  concurrency: z.number().int(),
  readyCount: z.number().int(),
  heldForMs: z.number().int(),
  holders: z.array(
    z.object({
      jobName: z.string(),
      jobId: z.string(),
      lockedForMs: z.number().int(),
    }),
  ),
  topReady: TopReadySchema.optional(),
  // Which tier of the runner ladder the frozen rows belong to. OPTIONAL —
  // reports filed before hold classes existed still parse.
  classes: z.array(ClassOccupancySchema).optional(),
});
export type QueueWedgedPayload = z.infer<typeof QueueWedgedPayloadSchema>;
