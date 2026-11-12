import { z } from "zod";

// The two kinds of monitor window an op's call count is judged in, each against
// its own history: `boot` — the first window of a backend process (every tab
// replays its subscriptions, catch-up runs), `steady` — every later one.
export const OP_RATE_REGIMES = ["boot", "steady"] as const;
export type OpRateRegime = (typeof OP_RATE_REGIMES)[number];

// What an op's calls were counted over when judged against its history: one
// window of a regime, or the clock hour so far (a sustained loop on an op whose
// windows are bursty stays under its usual window peak, never its usual hour).
export const OP_RATE_SPANS = [...OP_RATE_REGIMES, "hour"] as const;
export type OpRateSpan = (typeof OP_RATE_SPANS)[number];

// The jsonb payload for an `op-rate` report. One report per distinct hot op
// (`${kind}:${label}`), so a single hammered op gets its own report pointing
// straight at the cause. The payload carries the call-rate snapshot that tripped
// the threshold: which op, how many calls landed in the window, how long the
// window was, and the threshold it exceeded.
//   • `baseline` — judged against the op's own history: what the calls were
//     counted over (`over`: a boot or steady window, or the clock hour so far),
//     and how many calls the op usually makes over such a span (a high quantile
//     of its last 7 days); `threshold` is derived from it.
//   • no `baseline` — judged against the per-kind warm-up threshold, while this
//     backend has less than a day of history (and every report filed before
//     baselines existed).
export const OpRatePayloadSchema = z.object({
  kind: z.string(),
  label: z.string(),
  callsInWindow: z.number().int(),
  windowMs: z.number().int(),
  threshold: z.number().int(),
  baseline: z
    .object({
      over: z.enum(OP_RATE_SPANS),
      usualCalls: z.number().int(),
    })
    .optional(),
});
export type OpRatePayload = z.infer<typeof OpRatePayloadSchema>;

// The jsonb payload for an `op-time` report — the aggregate-time (count×cost)
// twin of op-rate. Two report shapes share this schema, discriminated by
// `label`:
//   • per-op    (`label` present) — ONE op burned `msInWindow` ms across
//     `callsInWindow` calls in the window, past its per-kind `budgetMs`. Carries
//     both ms AND calls so the renderer can state the rate×cost decomposition
//     ("N calls × ~M ms avg") and a `traceId` linking the coherent-instant flight
//     window captured at the trip.
//   • rollup    (`label` absent) — the sum of a kind's per-op ms deltas exceeded
//     `budgetMs` (= per-kind budget × rollupFactor), i.e. cost smeared across
//     many labels each under its own per-op budget. `topLabels` carries the
//     top-10 contributing labels with their ms deltas; no single op to point at,
//     so no `traceId`.
//   • gate      (`kind: "wait"`, `label` the layer) — the ms ops queued on one
//     gate in the window, past `waitMsPerWindow`; `callsInWindow` counts the
//     waits, `holders` names who held the gate when it tripped.
// `msInWindow` is OWN time for an op (its waits excluded — they are the
// gate's); `wallMsInWindow` is its wall time, for context.
export const OpTimePayloadSchema = z.object({
  kind: z.string(),
  label: z.string().optional(),
  msInWindow: z.number(),
  wallMsInWindow: z.number().optional(),
  holders: z.array(z.string()).max(10).optional(),
  callsInWindow: z.number().int(),
  windowMs: z.number().int(),
  budgetMs: z.number(),
  topLabels: z
    .array(z.object({ label: z.string(), deltaMs: z.number() }))
    .optional(),
  traceId: z.string().optional(),
});
export type OpTimePayload = z.infer<typeof OpTimePayloadSchema>;
