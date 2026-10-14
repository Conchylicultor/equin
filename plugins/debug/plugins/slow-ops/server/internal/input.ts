import type {
  SpanDetail,
  WaitBreakdown,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { ReportSource } from "@plugins/reports/core";
import type { CallerRef } from "../../core";

// The only report sources a slow-op originates from — narrowed from the
// canonical ReportSource union (now in reports/core), so this stays a checked
// subset of the real origins rather than a drifting hand-rolled copy.
export type SlowOpSource = Extract<
  ReportSource,
  "server-slow-op" | "client-slow-op" | "server-boot-monitor"
>;

export interface RecordSlowOpInput {
  operationKind: string;
  operation: string;
  durationMs: number;
  thresholdMs: number;
  // The report source attributed to the rollup report (server-slow-op vs
  // client-slow-op). The funnel doesn't infer it — the caller knows its origin.
  source: SlowOpSource;
  // Who issued this operation, when known. The caller-attribution fix: this is
  // what the whole refactor exists to capture. Server spans pass their immediate
  // enclosing span (a SpanRef); client `element` signals pass their route
  // ({ kind: "route", label }); page-load passes nothing. Lands on the op's
  // `slow_op_callers` row.
  caller?: CallerRef | null;
  // Per-layer wait charged to this entry span (gate/lock → ms), when it waited.
  // Merged per layer into the row's durable `waits` so the wait-vs-work split
  // survives restart. Only entry spans (loader/http/sub/push) carry it.
  waits?: WaitBreakdown;
  // The tripping span's variant (which instance ran — a loader's params) and
  // measures (fan-out, frame size, …). Merged into the row's `variants`
  // breakdown and `measures` stats, and stamped on the newest sample.
  detail?: SpanDetail;
  // Additive cold-start attribution (client `element` signal only). When the
  // notifications transport was not ready at resource mount, this duration is
  // transport time-to-first-data, not resource compute. Threaded into the report
  // `data` (jsonb — no migration) so the report title/description says WHY.
  transportColdStart?: boolean;
  transportWaitMs?: number;
  // The durable trace captured for this same trip (when the engine admitted
  // one). Stamped into the newest recentSamples entry and the report `data` so
  // the aggregate view and the slow-op task both deep-link the evidence. Null
  // when the trace was rate-limited or the engine is disabled.
  traceId?: string;
  // The instant the span actually tripped. Stamped by recordSlowOp itself
  // BEFORE the duress shed gate, so an item buffered during a duress episode
  // replays with its true in-freeze instant (recentSamples atTime, marker
  // line, lastSeenAt) instead of the post-episode flush time. Callers omit it.
  occurredAt?: Date;
}
