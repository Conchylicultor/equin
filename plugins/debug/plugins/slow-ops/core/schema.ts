import { z } from "zod";
import { ContentionSnapshotSchema } from "@plugins/infra/plugins/host/plugins/contention/core";
import {
  SPAN_MEASURES,
  type SpanMeasure,
  type WaitBreakdown,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { uuidField } from "@plugins/fields/plugins/uuid/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";

// Who issued an operation (the immediate enclosing request/loader span), before
// any per-occurrence counts are merged in — the identity the recorder folds
// into a `slow_op_callers` row. A SpanRef (server span parent) is structurally
// assignable to it; client signals supply { kind: "route", ... }.
export const CallerRefSchema = z.object({
  kind: z.string(),
  label: z.string(),
});
export type CallerRef = z.infer<typeof CallerRefSchema>;

// Per-layer wait charged to this operation (gate/lock name → summed ms): the
// durable wait-vs-work split. Mirrors the profiler's in-memory `waits`; merged
// per layer on each occurrence. `{}` when the op never waited on a gate.
export const WaitBreakdownSchema = z.record(z.string(), z.number());

// Per-variant breakdown: WHICH instance of the operation was slow (a loader's
// canonical params), how often and how slow — the per-row answer to "which
// param set", while the row itself stays one per operation. Bounded: the
// merge keeps the top `VARIANT_CAP` by totalMs and folds the rest into one
// `OTHER_VARIANT` entry.
export const VariantBreakdownSchema = z.object({
  variant: z.string(),
  count: z.number().int(),
  totalMs: z.number(),
  maxMs: z.number(),
});
export type VariantBreakdown = z.infer<typeof VariantBreakdownSchema>;
export const VARIANT_CAP = 10;
export const OTHER_VARIANT = "(other)";

// The largest and the latest value of each span measure (fan-out, frame size,
// scoped ids, time since the change) this operation carried when it was slow.
export const MeasureStatSchema = z.object({
  max: z.number(),
  last: z.number(),
});
export type MeasureStat = z.infer<typeof MeasureStatSchema>;
export const SlowOpMeasuresSchema = z.object(
  Object.fromEntries(
    SPAN_MEASURES.map((m) => [m, MeasureStatSchema.optional()]),
  ) as Record<SpanMeasure, z.ZodOptional<typeof MeasureStatSchema>>,
);
export type SlowOpMeasures = z.infer<typeof SlowOpMeasuresSchema>;

// One captured contention sample: the box state at the instant a span tripped
// its threshold, with the span's own duration. Stored as a capped ring on the
// aggregate row (newest first, last 10) so a storm's shape is visible per op
// without unbounded growth. `traceId` links
// the freshest sample to the durable trace the same trip captured (when the
// engine admitted one), so the aggregate view can deep-link the evidence.
export const SlowOpSampleSchema = z.object({
  atTime: z.coerce.date(),
  durationMs: z.number(),
  snapshot: ContentionSnapshotSchema,
  traceId: z.string().optional(),
  // The tripping span's own variant and measures, when it carried any.
  variant: z.string().optional(),
  measures: z
    .object(
      Object.fromEntries(
        SPAN_MEASURES.map((m) => [m, z.number().optional()]),
      ) as Record<SpanMeasure, z.ZodOptional<z.ZodNumber>>,
    )
    .optional(),
});
export type SlowOpSample = z.infer<typeof SlowOpSampleSchema>;

// One deduped slow-operation aggregate (the durable, restart-surviving analogue
// of the profiler's in-memory `Aggregate` + `byParent`, gated to
// threshold-exceeding spans). Keyed by (operationKind, operation, worktree).
export const slowOpFields = {
  id: uuidField(),
  worktree: textField(),
  operationKind: textField(),
  operation: textField(),
  count: intField(),
  totalMs: floatField(),
  maxMs: floatField(),
  lastMs: floatField(),
  thresholdMs: floatField(),
  waits: jsonField<WaitBreakdown>({ schema: WaitBreakdownSchema, default: {} }),
  variants: jsonField<VariantBreakdown[]>({
    schema: z.array(VariantBreakdownSchema),
    default: [],
  }),
  measures: jsonField<SlowOpMeasures>({
    schema: SlowOpMeasuresSchema,
    default: {},
  }),
  recentSamples: jsonField<SlowOpSample[]>({
    schema: z.array(SlowOpSampleSchema),
    default: [],
  }),
  firstSeenAt: dateField(),
  lastSeenAt: dateField(),
} satisfies FieldsRecord;

// The full row — what the table stores, and what the detail pane reads
// (`slow-ops.op`). Who issued the op is not on it: callers are their own paged
// collection (`slowOpCallerFields` below).
export const SlowOpSchema = fieldsToZodObject(slowOpFields);
export type SlowOp = z.infer<typeof SlowOpSchema>;

// One op as the ranked list reads it (`slow-ops.ops`): the counters only — no
// JSON list, so a 100-row window is a few KB. `waitMs` (the summed `waits`)
// and `lastTraceId` (the newest sample's trace) are derived server-side. The
// listed fields are the ones the list filters by (labelled); the rest ride the
// row, in no list.
export const SLOW_OP_LIST_LISTED = {
  operationKind: textField({ label: "Kind" }),
  operation: textField({ label: "Operation" }),
  count: intField({ label: "Count" }),
  totalMs: floatField({ label: "Total" }),
  lastSeenAt: dateField({ label: "Last seen" }),
};
export const SLOW_OP_LIST_CARRIED = {
  id: slowOpFields.id,
  worktree: slowOpFields.worktree,
  maxMs: slowOpFields.maxMs,
  lastMs: slowOpFields.lastMs,
  thresholdMs: slowOpFields.thresholdMs,
  firstSeenAt: slowOpFields.firstSeenAt,
  waitMs: floatField(),
  lastTraceId: nullable(textField()),
};
export const SlowOpListRowSchema = fieldsToZodObject({
  ...SLOW_OP_LIST_CARRIED,
  ...SLOW_OP_LIST_LISTED,
});
export type SlowOpListRow = z.infer<typeof SlowOpListRowSchema>;

// Who issued a slow op, one row per (op, caller): how often and how slow. The
// op is named by its key (operationKind, operation, worktree), not by
// `slow_ops.id`, so the detail's callers window filters on text columns and
// the recorder writes it without looking the op up. Additive counters only —
// nothing is capped or folded; the detail pages them by total time.
export const slowOpCallerFields = {
  id: uuidField(),
  worktree: textField(),
  operationKind: textField(),
  operation: textField(),
  callerKind: textField(),
  callerLabel: textField(),
  count: intField(),
  totalMs: floatField(),
  maxMs: floatField(),
  firstSeenAt: dateField(),
  lastSeenAt: dateField(),
} satisfies FieldsRecord;

// The callers window filters by op and caller (labelled); the rest ride the row.
export const SLOW_OP_CALLER_LISTED = {
  operationKind: textField({ label: "Kind" }),
  operation: textField({ label: "Operation" }),
  callerKind: textField({ label: "Caller kind" }),
  callerLabel: textField({ label: "Caller" }),
};
export const SLOW_OP_CALLER_CARRIED = {
  id: slowOpCallerFields.id,
  worktree: slowOpCallerFields.worktree,
  count: slowOpCallerFields.count,
  totalMs: slowOpCallerFields.totalMs,
  maxMs: slowOpCallerFields.maxMs,
  firstSeenAt: slowOpCallerFields.firstSeenAt,
  lastSeenAt: slowOpCallerFields.lastSeenAt,
};

export const SlowOpCallerSchema = fieldsToZodObject(slowOpCallerFields);
export type SlowOpCaller = z.infer<typeof SlowOpCallerSchema>;

// The web-safe overlay shape for the health-monitor charts: a slim projection of
// a sample (no full contention snapshot), published one-per-recorded-slow-op to
// the persisted `slow-op-markers` channel and read back per worktree to draw a
// severity-colored ReferenceLine at each spike's timestamp.
export const SlowOpMarkerSchema = z.object({
  atTime: z.coerce.date(), // wall-clock instant the span tripped
  durationMs: z.number(),
  operationKind: z.string(),
  operation: z.string(),
  loadAvg1: z.number(), // for the severity ramp
  cpuCount: z.number(),
});
export type SlowOpMarker = z.infer<typeof SlowOpMarkerSchema>;

// Load relative to cores is the contention signal: ≥1.5× cores = saturated
// (warning), ≥2.5× = severe (destructive). The single source of truth for the
// muted→warning→destructive ramp, shared by the cluster timeline badges and the
// health-monitor spike-line overlay.
export function loadSeverity(
  loadAvg1: number,
  cpuCount: number,
): "muted" | "warning" | "destructive" {
  const ratio = cpuCount > 0 ? loadAvg1 / cpuCount : 0;
  if (ratio >= 2.5) return "destructive";
  if (ratio >= 1.5) return "warning";
  return "muted";
}
