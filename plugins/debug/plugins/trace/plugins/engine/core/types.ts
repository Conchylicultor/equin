import { z } from "zod";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";

// ---------------------------------------------------------------------------
// The trace wire model (snapshot v2). Plain, closed, cross-runtime data — so it
// lives in core/ (per the server-core CLAUDE.md rule): the server persists it,
// the web renders it, and other plugins deep-link it. The OPEN set — which perf
// event classes contribute snapshot sections — is the server-side
// `TraceEventClass` registry, NOT this file; here `events` is an opaque
// classId → payload map (each payload validated by its class's own schema
// before it lands here).
//
// flight-recorder snapshots were v1 (JSONL, dead-ended); this is v2 (durable,
// DB-backed, self-describing via the `events` keys).
// ---------------------------------------------------------------------------

// What tripped the trace. An OPEN vocabulary (`kind`): a slow span, a slow
// client signal, an op-time budget breach, a future GC-pause detector — any
// plugin may mint one and hand it to captureTrace.
export const TraceTriggerSchema = z.object({
  kind: z.string(),
  label: z.string(),
  durationMs: z.number(),
  thresholdMs: z.number(),
  // Trigger-specific extras (a SpanRef parent, wait breakdown, self/child ms…).
  // Opaque to the engine; a TriggerSummary web view narrows it by kind.
  detail: z.unknown().optional(),
  // A critical trigger (e.g. an event-loop stall — a frozen backend) bypasses the
  // global per-minute cap so a slow-event storm can never starve the most severe
  // signal. The per-trigger cooldown still applies (recurring identical incidents
  // dedupe). Reserve for genuinely severe, low-frequency signals.
  critical: z.boolean().optional(),
});
export type TraceTrigger = z.infer<typeof TraceTriggerSchema>;

export const TraceSnapshotSchema = z.object({
  v: z.literal(2),
  id: z.string(),
  // Profiler-clock instant (performance.now domain) the trace was captured at.
  atMs: z.number(),
  // Wall-clock anchor (ISO). The single join point to human time; profiler-clock
  // values (atMs / windowStartMs / span t0/t1) only ever compare to each other.
  wallTime: z.string(),
  worktree: z.string(),
  // atMs − max(trigger.durationMs, cfg.windowMs): the left edge of the captured
  // window, so a long trip always covers its own lifetime.
  windowStartMs: z.number(),
  trigger: TraceTriggerSchema,
  // classId → the class's schema-validated section. The engine never names a
  // key; a section that fails its class schema is omitted (and reported), never
  // faked, so a present key is always valid.
  events: wholeRecord(z.unknown(), {
    reason: "one section per registered trace event class",
  }),
});
export type TraceSnapshot = z.infer<typeof TraceSnapshotSchema>;

// ---------------------------------------------------------------------------
// Runtime capture contracts (engine-internal, not persisted). Exported from
// core so the built-in class plugins (spans/gates/contention) can type their
// captureAtTrip / enrich signatures against them without importing server code.
// ---------------------------------------------------------------------------

// The coherent-instant context handed to every class at a trip. Minted
// synchronously so `id` precedes persistence and links a report/row to its
// trace before the async enrich even starts.
export interface TripContext {
  /** Trace id (uuid), minted synchronously for linkage. */
  id: string;
  /** Profiler clock (performance.now domain). */
  atMs: number;
  /** ISO wall-clock anchor. */
  wallTime: string;
  /** atMs − max(trigger.durationMs, cfg.windowMs). */
  windowStartMs: number;
  trigger: TraceTrigger;
}

// One event a ring-backed class emits continuously (samples, markers). `tMs` is
// on the profiler clock (performance.now domain), so a slice overlapping
// [windowStartMs, atMs] joins the same timeline as the spans/gates sections.
export interface RingEvent {
  tMs: number;
  data: unknown;
}
