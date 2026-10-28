import type { z } from "zod";
import {
  defineServerContribution,
  type ServerContribution,
} from "@plugins/framework/plugins/server-core/core";
import type { TripContext, RingEvent } from "../../core";

// ---------------------------------------------------------------------------
// The generic perf-event class registry — the hard requirement of this plugin.
// The engine NEVER names a class; the pane NEVER names a class. Adding a perf
// signal to every trace + the Gantt is ONE new plugin that lists a
// defineTraceEventClass contribution — zero engine edits. Mirrors reports'
// ReportKindSpec + defineServerContribution.
// ---------------------------------------------------------------------------

// What one event class contributes to a trace snapshot's `events[id]` section.
export interface TraceEventClassSpec<T = unknown> {
  /** Stable lane/section id, e.g. "spans", "gates", "contention", "heap". */
  id: string;
  /** Validates this class's section. Persisted under snapshot.events[id]. */
  schema: z.ZodType<T>;
  /**
   * Phase 1 — runs SYNCHRONOUSLY at the trip instant, in the profiler hot path.
   * Must be cheap (no IO, no heavy allocation) and never throw (the engine
   * guards it, but a throw wastes the instant); this is what makes the snapshot
   * a coherent instant. Return undefined to skip.
   */
  captureAtTrip?(ctx: TripContext): unknown;
  /**
   * Phase 2 — async enrichment, run by the engine under runWithoutProfiling.
   * Receives the phase-1 output + this class's ring slice (events overlapping
   * [windowStartMs, atMs]). The returned value is schema-validated and
   * persisted. Return undefined to skip the section for this trip (no error,
   * no report) — the same skip semantics as captureAtTrip, so an enrich-only
   * class that only reacts to certain triggers can opt out cleanly. When
   * absent, the phase-1 output (or, failing that, the ring slice) is persisted
   * directly.
   */
  enrich?(
    ctx: TripContext,
    atTrip: unknown,
    ringSlice: RingEvent[],
  ): Promise<T | undefined> | T | undefined;
  /**
   * Ambient ring: the engine keeps a bounded in-memory ring of events this
   * class emits continuously (via the handle's `emit`). At a trip, events
   * overlapping the window are handed to enrich (or persisted directly when no
   * enrich) — how a future RAM/GC sampler gets a Gantt lane for free.
   */
  ring?: { max: number };
}

export const TraceEventClass = defineServerContribution<TraceEventClassSpec>(
  "trace-event-class",
  { docLabel: (s) => s.id },
);

// A bounded in-memory ring per class. Small `max` (a class caps its own sample
// rate), so the O(n) shift on overflow is trivial; correctness over cleverness.
class EventRing {
  private readonly buf: RingEvent[] = [];
  constructor(private readonly max: number) {}
  push(event: RingEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.max) this.buf.shift();
  }
  /** Events with tMs in [startMs, endMs], oldest first (timeline order). */
  slice(startMs: number, endMs: number): RingEvent[] {
    return this.buf.filter((e) => e.tMs >= startMs && e.tMs <= endMs);
  }
}

// The live ring for each ring-backed class, keyed by class id — the runtime twin
// of the contribution's static `ring: { max }`. Written by defineTraceEventClass
// at import time, read by the capture phase. A class with no `ring` has no entry
// and its `emit` is a no-op.
const ringsById = new Map<string, EventRing>();

export function getRing(id: string): { slice: EventRing["slice"] } | undefined {
  return ringsById.get(id);
}

// The handle a class plugin lists: `contribution` goes into its `contributions`
// array; `emit` appends to this class's ring (functional only when `ring` is
// declared — otherwise a no-op, so a class that forgets `ring` fails loudly by
// its events simply never appearing rather than throwing).
export interface TraceEventClassHandle {
  contribution: ServerContribution;
  emit(event: RingEvent): void;
}

export function defineTraceEventClass<T>(
  spec: TraceEventClassSpec<T>,
): TraceEventClassHandle {
  if (spec.ring) {
    if (ringsById.has(spec.id)) {
      throw new Error(`defineTraceEventClass: duplicate class id "${spec.id}"`);
    }
    ringsById.set(spec.id, new EventRing(spec.ring.max));
  }
  return {
    contribution: TraceEventClass(spec as TraceEventClassSpec),
    emit: (event) => {
      ringsById.get(spec.id)?.push(event);
    },
  };
}

// Test seam: reset the ring registry between suites.
export function resetTraceRings(): void {
  ringsById.clear();
}
