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

// A section a producer hands in for one class, minted only by that class's
// handle (`supply`), so it names its class by construction and its value is
// typed by the class's own section type. The engine takes it as the class's
// phase-1 output — still validated against the class schema, so a malformed
// one is reported and omitted like any other bad section.
declare const suppliedBrand: unique symbol;
export interface SuppliedTraceSection {
  readonly classId: string;
  readonly value: unknown;
  readonly [suppliedBrand]: true;
}

// The handle a class plugin lists: `contribution` goes into its `contributions`
// array; `emit` appends to this class's ring (functional only when `ring` is
// declared — otherwise a no-op, so a class that forgets `ring` fails loudly by
// its events simply never appearing rather than throwing); `supply` is how a
// producer that pre-aggregated this class's evidence hands it to captureTrace.
//
// A TRIGGER-OWNED class (stall, boot, client-boot) is one that only ever gets
// its section this way: it has no captureAtTrip, so it reads no trigger kind
// and no `detail`. Keying such a class on `trigger.kind` let any producer
// reusing the kind (the client's in-browser host boot, kind "boot") feed it a
// foreign detail, failing validation on every trip (2026-11-12 → 11-15, 13×).
export interface TraceEventClassHandle<T = unknown> {
  contribution: ServerContribution;
  emit(event: RingEvent): void;
  supply(value: T): SuppliedTraceSection;
}

export function defineTraceEventClass<T>(
  spec: TraceEventClassSpec<T>,
): TraceEventClassHandle<T> {
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
    supply: (value) => ({ classId: spec.id, value }) as SuppliedTraceSection,
  };
}

// Test seam: reset the ring registry between suites.
export function resetTraceRings(): void {
  ringsById.clear();
}
