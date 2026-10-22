import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

export const PUSH_BUCKETS = ["day", "week", "month"] as const;
export type PushBucket = (typeof PUSH_BUCKETS)[number];

// The one param every chart takes: the bucket width, typed (a wire string the
// parser only narrows). Required — the section always names its bucket.
const bucketParams = { bucket: z.enum(PUSH_BUCKETS) };

// The rows are this machine's op log (op-store's `op_log_ops`, ingested from
// the host's `op-log.jsonl`), so — like op-store's own collections — only the
// desktop app answers: a host without the computer reads `unavailable`.
const PUSHES_ON_THIS_MACHINE = {
  feature: "Pushes on this machine",
} as const;

// BOUND (every value below): one point per bucket that holds a completed push,
// within the op store's 30-day retention sweep — the range, not the user's
// data, bounds the list. No exact maximum is quoted: a forked worktree DB holds
// the rows its fork copied until its own sweep runs (40 day points were seen on
// one), so the bound is the retention window plus that lag, not "31".

export const PushesWaitTimeSchema = z.object({
  points: z.array(
    z.object({
      bucket: z.string(),
      avg: z.number(),
      max: z.number(),
      contested: z.number(),
      total: z.number(),
    }),
  ),
});

/**
 * Avg / max lock wait (seconds) per bucket over the contested pushes, plus the
 * `contested` / `total` counts. Bounded by the op store's 30-day retention
 * (see BOUND above).
 */
export const pushesWaitTime = liveValue("stats.pushes.wait-time", {
  schema: PushesWaitTimeSchema,
  params: bucketParams,
  needsMachine: PUSHES_ON_THIS_MACHINE,
});

export const PushesThroughputSchema = z.object({
  points: z.array(
    z.object({
      bucket: z.string(),
      success: z.number(),
      failed: z.number(),
    }),
  ),
});

/**
 * Success vs failed pushes per bucket. Bounded by the op store's 30-day
 * retention (see BOUND above).
 */
export const pushesThroughput = liveValue("stats.pushes.throughput", {
  schema: PushesThroughputSchema,
  params: bucketParams,
  needsMachine: PUSHES_ON_THIS_MACHINE,
});

export const PushesStepBreakdownSchema = z.object({
  points: z.array(
    z.object({
      bucket: z.string(),
      fetch: z.number(),
      rebase: z.number(),
      checks: z.number(),
      push: z.number(),
      other: z.number(),
    }),
  ),
});

/**
 * Avg seconds per push in each step group, per bucket. Bounded by the op
 * store's 30-day retention (see BOUND above).
 */
export const pushesStepBreakdown = liveValue("stats.pushes.step-breakdown", {
  schema: PushesStepBreakdownSchema,
  params: bucketParams,
  needsMachine: PUSHES_ON_THIS_MACHINE,
});
