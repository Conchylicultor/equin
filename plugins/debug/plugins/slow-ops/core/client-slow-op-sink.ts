import { defineObservationSink } from "@plugins/primitives/plugins/report-sink/core";
import type { CallerRef } from "./schema";

/**
 * One client slow-op measured by a plugin outside slow-ops — a fully-formed
 * item: the producer owns its kind, its operation key and the bar it judged
 * itself against. The slow-ops collector forwards every emit to the client
 * beacon unchanged (it never filters or names a kind).
 *
 * `endedAt` (epoch ms) is the instant the operation ended, for a producer that
 * files AFTER the fact (a main-thread stall is filed once the tab recovers, or
 * by another tab once it is gone): the sample then lands at its true instant,
 * so the Timeline draws the interval where it happened rather than at receipt.
 * Omitted ⇒ the server's receipt time, as for every other client signal.
 */
export interface ClientSlowOpSignal {
  operationKind: string;
  operation: string;
  durationMs: number;
  thresholdMs: number;
  caller?: CallerRef;
  waits?: Record<string, number>;
  detail?: { variant?: string };
  endedAt?: number;
}

/**
 * The public channel into the client slow-op queue for producers outside
 * slow-ops (the queue and its endpoint are slow-ops-private). Observation
 * semantics: an emit while the collector is not mounted is dropped.
 */
export const clientSlowOpSink = defineObservationSink<ClientSlowOpSignal>();
