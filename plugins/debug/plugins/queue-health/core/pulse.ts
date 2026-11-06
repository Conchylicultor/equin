import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  HOLD_CLASSES,
  HoldClassSchema,
  TOTAL_JOB_SLOTS,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/core";
import { QUEUE_TONES } from "./verdict";

// The Job queue row's live payload: what the health report needs to colour the
// dot, draw the per-class bars and list the jobs behind the colour — built by
// `server/internal/pulse.ts` from the jobs plugin's slot ledger (memory) and
// three bounded queries, and pushed on queue activity.
//
// Every array is `.max()`-bounded, so the payload's size is a fact of the schema
// rather than of the queries that happen to fill it today.

/** How many waiting rows the pulse lists, most severe first. */
export const PULSE_WAITING_LIMIT = 5;

/** How many dead job names the pulse lists, most recent first. */
export const PULSE_DEAD_LIMIT = 5;

/** How far back the pulse lists deaths. The attention window
 * (`deadJobAttentionMinutes`) is a separate, shorter line. */
export const PULSE_DEAD_WINDOW_MS = 24 * 60 * 60_000;

export const QueueToneSchema = z.enum(QUEUE_TONES);

// Keyed by class, derived from the class table rather than spelled out.
const ClassToneSchema = z.object(
  Object.fromEntries(HOLD_CLASSES.map((hold) => [hold, QueueToneSchema])) as {
    [K in HoldClass]: typeof QueueToneSchema;
  },
);

/** Pickup delay (`run_at` → `locked_at`) over the ledger's window. `count: 0`
 * means no pickups, and every percentile is then `null` — never `0`. */
export const PickupStatsSchema = z.object({
  count: z.number().int().min(0),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  maxMs: z.number().nullable(),
});

export const QueueClassPulseSchema = z.object({
  hold: HoldClassSchema,
  /** Slots this class can ever reach (`reachableSlots`). */
  reachable: z.number().int(),
  /** `reachable` minus the forfeited ones among them. */
  usable: z.number().int(),
  /** Of the reachable slots, how many hold a job (forfeited ones included). The
   * bars share slots, so these add up past the pool size across classes. */
  busy: z.number().int(),
  /** Of the reachable slots, how many are written off by a stuck job. */
  forfeited: z.number().int(),
  /** Rows waiting for a slot. Rows queued behind a held serial lane are not
   * counted here — they wait by design (`behindLanes`). */
  waiting: z.number().int(),
  /** `run_at` of the oldest waiting row (epoch ms); `null` when none wait. */
  oldestWaitingRunAt: z.number().nullable(),
  behindLanes: z.number().int(),
  pickup: PickupStatsSchema,
});

export const QueueRunningJobSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  hold: HoldClassSchema,
  runnerId: z.string(),
  /** When the slot took it (epoch ms). */
  lockedAt: z.number(),
  /** Held past the slot-hog line, or forfeited. */
  stuck: z.boolean(),
  /** The slot is written off (`forfeit`): the run ignored its deadline. */
  forfeited: z.boolean(),
});

export const QueueWaitingJobSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  hold: HoldClassSchema,
  /** When it became due (epoch ms). */
  runAt: z.number(),
  attempts: z.number().int(),
  /** The colour this row's own wait gives, at load time. */
  tone: QueueToneSchema,
});

export const QueueDeadGroupSchema = z.object({
  jobName: z.string(),
  /** Deaths in the last `PULSE_DEAD_WINDOW_MS`. */
  count: z.number().int(),
  lastDiedAt: z.number(),
  lastError: z.string().nullable(),
  /** Died within `deadJobAttentionMinutes` — it colours the row. */
  recent: z.boolean(),
});

export const QueueVerdictSchema = z.object({
  state: QueueToneSchema,
  summary: z.string(),
  cause: ClassToneSchema,
});

export const QueuePulseSchema = z.object({
  /** One per class, in `HOLD_CLASSES` order. */
  classes: z.array(QueueClassPulseSchema).max(HOLD_CLASSES.length),
  /** Every slot holding a job in this backend, longest-held first. */
  running: z.array(QueueRunningJobSchema).max(TOTAL_JOB_SLOTS),
  oldestWaiting: z.array(QueueWaitingJobSchema).max(PULSE_WAITING_LIMIT),
  dead: z.array(QueueDeadGroupSchema).max(PULSE_DEAD_LIMIT),
  /** Rows locked in the database but held by no slot of this backend — a dead
   * worker's, which the stuck-lock sweeper reclaims. Never negative. */
  orphanLocked: z.number().int().min(0),
  /** The window the pickup stats cover, as the server measures it. */
  pickupWindowMs: z.number(),
  verdict: QueueVerdictSchema,
});

export type QueuePulse = z.infer<typeof QueuePulseSchema>;
export type QueueClassPulse = z.infer<typeof QueueClassPulseSchema>;
export type QueueRunningJob = z.infer<typeof QueueRunningJobSchema>;
export type QueueWaitingJob = z.infer<typeof QueueWaitingJobSchema>;
export type QueueDeadGroup = z.infer<typeof QueueDeadGroupSchema>;

// Not boot-critical: the row's socket is still connecting at first paint
// anyway, and a boot-critical value would add these reads to every page load.
// No placeholder: before the first load the row reads as loading, never as an
// idle queue. Served external (`server/internal/pulse.ts`).
export const queuePulse = liveValue("queue-health.pulse", {
  schema: QueuePulseSchema,
});

// The row's always-on read: only what colours the dot and writes its summary.
// Every tab's health report holds this subscription whether or not the popover
// is open, so it carries the verdict alone — a few dozen bytes that change only
// when the colour or summary does (an unchanged load is not pushed). The full
// `queuePulse` — running jobs, pickup stats, bars, all moving on every job start
// and finish — is subscribed only by the glance and detail, which render while
// the report is open. Same loader reads, same timer (`server/internal/pulse.ts`).
export const queueVerdictValue = liveValue("queue-health.verdict", {
  schema: QueueVerdictSchema,
});
