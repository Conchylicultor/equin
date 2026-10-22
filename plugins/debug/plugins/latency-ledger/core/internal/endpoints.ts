import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BUCKET_COUNT, HISTOGRAM_SCHEME } from "./histogram";
import { CLIENT_METRICS, LATENCY_METRICS } from "./metrics";

// --- Browser → server -----------------------------------------------------------

/** One metric's samples for one minute, as the browser accumulated them. */
export const ClientMinuteSchema = z.object({
  metric: z.enum(CLIENT_METRICS),
  /** Epoch ms of the minute's start. */
  minuteStart: z.number().int().nonnegative(),
  counts: z.array(z.number().int().nonnegative()).length(BUCKET_COUNT),
  count: z.number().int().nonnegative(),
  sumMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
  censored: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
});
export type ClientMinute = z.infer<typeof ClientMinuteSchema>;

/** One page load or in-app navigation, kept raw: there are few, and the route matters. */
export const InteractionSchema = z.object({
  kind: z.enum(["page-load", "navigate"]),
  /** Epoch ms at which it ended. */
  occurredAt: z.number().int().nonnegative(),
  route: z.string().max(500),
  durationMs: z.number().nonnegative(),
  /** The tab was hidden at some point: timers were throttled, the number means little. */
  hidden: z.boolean(),
  /** Still waiting for data after 60 s, or cut short by the next navigation. */
  censored: z.boolean(),
  /** Lists that started loading during it. */
  resourceCount: z.number().int().nonnegative(),
  /** The list that got its data last. */
  lastResourceKey: z.string().max(200).nullable(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

export const submitClientLatency = defineEndpoint({
  route: "POST /api/latency-ledger/client",
  // Latency histograms and interactions only: an agent session's samples are
  // observability like a user's (main is read-only for agents otherwise).
  agentWrite: "telemetry",
  body: z.object({
    scheme: z.literal(HISTOGRAM_SCHEME),
    minutes: z.array(ClientMinuteSchema).max(60),
    interactions: z.array(InteractionSchema).max(100),
  }),
  response: z.object({ ok: z.boolean() }),
});

// --- Summary --------------------------------------------------------------------

const StatSchema = z.object({
  /** Samples the percentiles are computed from. */
  count: z.number(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  maxMs: z.number().nullable(),
  /** Of `count`: samples known only as "at least this long". */
  censored: z.number(),
});
export type LatencyStat = z.infer<typeof StatSchema>;

export const LATENCY_WINDOWS = ["1h", "24h", "7d"] as const;
export type LatencyWindow = (typeof LATENCY_WINDOWS)[number];

export const LatencySummarySchema = z.object({
  window: z.enum(LATENCY_WINDOWS),
  /**
   * Minutes of the window the server recorded, by class. `slept`: the machine
   * slept in it, so its samples are left out. A minute the server did not record
   * at all (it was down) is not here; samples the browser sent for such a minute
   * show under each metric's `unknown`.
   */
  minutes: z.object({
    calm: z.number(),
    pressure: z.number(),
    slept: z.number(),
  }),
  metrics: z.array(
    z.object({
      metric: z.enum(LATENCY_METRICS),
      calm: StatSchema,
      pressure: StatSchema,
      /** Samples in minutes with no host record (server down or not yet flushing). */
      unknown: StatSchema,
      /** Samples left out: hidden tab, or a minute in which the machine slept. */
      excluded: z.number(),
    }),
  ),
  /** Share of 10 s windows in which the serving thread's worst lag passed the bar. */
  threadStalls: z.object({
    thresholdMs: z.number(),
    calm: z.object({ windows: z.number(), over: z.number() }),
    pressure: z.object({ windows: z.number(), over: z.number() }),
  }),
  criteria: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      targetMs: z.number(),
      valueMs: z.number().nullable(),
      samples: z.number(),
      verdict: z.enum(["pass", "fail", "no-data"]),
    }),
  ),
  /** Where the serving thread's time went, by the plugin whose code was running. */
  threadOwners: z.object({
    /** Stack samples in the window. The sampler only samples a busy thread. */
    samples: z.number(),
    /** Estimated share of wall time the thread was running code, 0..1, or null. */
    busyShare: z.number().nullable(),
    owners: z.array(z.object({ owner: z.string(), share: z.number() })),
  }),
  slowestInteractions: z.array(InteractionSchema),
});
export type LatencySummary = z.infer<typeof LatencySummarySchema>;
