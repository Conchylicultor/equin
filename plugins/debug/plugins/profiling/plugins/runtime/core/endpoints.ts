import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  SPAN_KINDS,
  SPAN_MEASURES,
  type SpanKind,
  type SpanMeasure,
} from "@plugins/infra/plugins/runtime-profiler/core";

// Mirrors the recorder's getRuntimeProfile() return shape
// (@plugins/infra/plugins/runtime-profiler/core). A response schema is required
// for useEndpoint/fetchEndpoint to actually return parsed data on the client —
// the server ignores it, so it is client-safe.
// Derived from the runtime-profiler's single SPAN_KINDS source, so a new kind can
// never silently drift out of the response schema (a hand-mirrored enum passed
// tsc but rejected `cascade` at runtime — the failure mode this derivation ends).
const spanKindSchema = z.enum(SPAN_KINDS);

// Read across code generations: an MCP tool or a fleet fan-out reads ANY
// worktree's backend through the gateway, and each runs its own commit. So a
// field or span kind added to these replies is defaulted, never required — an
// older backend's reply still parses, reading what it never recorded as
// recorded-nothing (0 / an empty list), never as a value fabricated from other
// fields. A field the contract cannot default (a renamed or retyped one) is a
// breaking change: the reader's parse fails loudly on the older backend.
const sinceAdded = z.number().default(0);

const spanRefSchema = z.object({
  kind: spanKindSchema,
  label: z.string(),
});

const parentBreakdownSchema = z.object({
  parent: spanRefSchema,
  count: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
});

// Per-layer wait charged to an entry (gate/lock name → ms). Each value is an
// interval union over the entry's own timeline (≤ its wall-clock), propagated
// to every open ancestor entry. Absent when the entry never waited.
const waitBreakdownSchema = z.record(z.string(), z.number());

// Numbers a span carries beside its duration (fan-out, frame size, …), keyed by
// the recorder's closed SPAN_MEASURES set.
const spanMeasuresSchema = z.object(
  Object.fromEntries(
    SPAN_MEASURES.map((m) => [m, z.number().optional()]),
  ) as Record<SpanMeasure, z.ZodOptional<z.ZodNumber>>,
);

const spanDetailSchema = z.object({
  variant: z.string().optional(),
  measures: spanMeasuresSchema.optional(),
});

const aggregateSchema = z.object({
  label: z.string(),
  count: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
  lastMs: z.number(),
  // Σ per-record wait/child/self unions — per-call averages are /count. Per
  // record they decompose the wall-clock: waitMs (union of gate waits at any
  // subtree depth) + childMs (union of direct-child executions, overlapping
  // waits) and selfMs = wall − union(waits ∪ children).
  waitTotalMs: sinceAdded,
  childTotalMs: sinceAdded,
  selfTotalMs: sinceAdded,
  // Max duration within the rolling ~5-min window (0 if idle past it), vs the
  // since-boot maxMs whose age is maxAgeMs — so a stale peak reads as stale.
  recentMaxMs: sinceAdded,
  maxAgeMs: sinceAdded,
  byParent: z.array(parentBreakdownSchema),
  waits: waitBreakdownSchema.optional(),
  measuresMax: spanMeasuresSchema.optional(),
});

const slowSpanSchema = z.object({
  // Per-instance identity: `id` names this span RUN, `parentId` the enclosing
  // entry run (null at the top level). The `parent` SpanRef below is the
  // per-LABEL attribution — the two answer different questions.
  id: z.number(),
  parentId: z.number().nullable(),
  kind: spanKindSchema,
  label: z.string(),
  durationMs: z.number(),
  atMs: z.number(),
  parent: spanRefSchema.nullable(),
  waits: waitBreakdownSchema.optional(),
  // Per-span wall-clock decomposition (unions; leaves are 0/0/durationMs).
  waitMs: sinceAdded,
  childMs: sinceAdded,
  selfMs: sinceAdded,
  detail: spanDetailSchema.optional(),
});

// One array per span kind, derived from SPAN_KINDS so a new kind cannot drift
// out of the response schema — defaulted, since an older backend has no list
// for a kind added after it (it recorded none, which an empty list says).
const byKind = <T extends z.ZodTypeAny>(item: T) =>
  z.object(
    Object.fromEntries(
      SPAN_KINDS.map((k) => [k, z.array(item).default([])]),
    ) as Record<SpanKind, z.ZodDefault<z.ZodArray<T>>>,
  );

export const runtimeProfileSchema = z.object({
  aggregates: byKind(aggregateSchema),
  slowest: byKind(slowSpanSchema),
  sinceMs: z.number(),
  // Elapsed wall-time of the current profiling window (now − sinceMs), computed
  // server-side. `sinceMs` is a process-relative performance.now() value, not an
  // epoch — the client can't derive elapsed from it alone, so the handler does.
  windowMs: z.number(),
});

export const getRuntimeProfile = defineEndpoint({
  route: "GET /api/debug/profiling/runtime",
  response: runtimeProfileSchema,
});

export const resetRuntimeProfile = defineEndpoint({
  route: "POST /api/debug/profiling/runtime/reset",
});

// --- Flight window ----------------------------------------------------------

export const FLIGHT_WINDOW_MS_DEFAULT = 15_000;
export const FLIGHT_WINDOW_MS_MIN = 1_000;
export const FLIGHT_WINDOW_MS_MAX = 120_000;

// Out-of-range values are CLAMPED, not rejected: the caller is another
// backend's enrich pass mid-incident — a mis-tuned windowMs should still yield
// a bounded capture, not a 400. Non-numeric input still fails validation.
export const flightWindowQuerySchema = z.object({
  windowMs: z.coerce
    .number()
    .finite()
    .default(FLIGHT_WINDOW_MS_DEFAULT)
    .transform((v) =>
      Math.min(FLIGHT_WINDOW_MS_MAX, Math.max(FLIGHT_WINDOW_MS_MIN, v)),
    ),
});

// Mirrors the recorder's FlightSpan/FlightWindow shapes
// (@plugins/infra/plugins/runtime-profiler/core), same client-safety rationale
// as runtimeProfileSchema above.
const waitBandSchema = z.object({
  layer: z.string(),
  t0: z.number(),
  t1: z.number(),
});

const flightSpanSchema = z.object({
  id: z.number(),
  parentId: z.number().nullable(),
  kind: spanKindSchema,
  label: z.string(),
  t0: z.number(),
  // null => still open at capture.
  t1: z.number().nullable(),
  ageMs: z.number(),
  waitMs: sinceAdded,
  childMs: sinceAdded,
  selfMs: sinceAdded,
  waits: waitBreakdownSchema.optional(),
  waitBands: z.array(waitBandSchema).optional(),
});

// All t0/t1/atMs values inside `window` are THIS backend's performance.now()
// clock — meaningless to another process. `wallAnchor` pairs one instant on
// that clock (`atMs`) with the wall clock (`wallTime`, ISO), so a cross-backend
// consumer converts any profiler value t via:
//   wall = Date.parse(wallTime) + (t - atMs)
export const flightWindowResponseSchema = z.object({
  wallAnchor: z.object({
    atMs: z.number(),
    wallTime: z.string(),
  }),
  window: z.object({
    atMs: z.number(),
    open: z.array(flightSpanSchema),
    completed: z.array(flightSpanSchema),
  }),
});

// Per-backend flight window (in-flight + recently-completed spans). Fetched
// gateway-mediated by the Phase-B fleet-flights trace class during
// cluster-onset captures, so a main-side trace can show what every running
// backend was doing at the trip instant.
export const getFlightWindow = defineEndpoint({
  route: "GET /api/debug/profiling/flight-window",
  query: flightWindowQuerySchema,
  response: flightWindowResponseSchema,
});
