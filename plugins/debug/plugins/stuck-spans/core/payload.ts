import { z } from "zod";

// The report kind this plugin files. One literal, read by both the server
// `ReportKind` and the web `Reports.KindView`, so the two can never disagree.
// Persisted report rows key on it — do not rename.
export const SPAN_STUCK_KIND = "span-stuck";

// One open ancestor of the stuck span, as it stood when the watchdog saw it.
const StuckAncestorSchema = z.object({
  id: z.number().int(),
  // A span kind. Stored as a plain string rather than an enum over the
  // profiler's current `SPAN_KINDS`: this is persisted data, and a row written
  // under an older kind set must still parse after the set changes.
  kind: z.string(),
  label: z.string(),
  ageMs: z.number(),
});
export type StuckAncestor = z.infer<typeof StuckAncestorSchema>;

// A caller holding the gate's capacity when the watchdog looked, as the gate
// names it (runtime-profiler's `GateHolder`).
const GateHolderSchema = z.object({
  label: z.string(),
  heldMs: z.number(),
});

// The runs of one operation queued on the gate.
const GateWaiterSchema = z.object({
  kind: z.string(),
  label: z.string(),
  runs: z.number().int().min(1),
});

// Set when the finding is a GATE that does not admit its waiters, not an
// operation stuck in its own work. Every run found queued on the gate on one
// tick is one report about the gate (fingerprint `span-stuck:gate:<layer>`):
// the waiters waited for its holders, so the holders are what is named.
const StuckGateSchema = z.object({
  // The gate's layer, in the runtime profiler's wait vocabulary (`read-admit`,
  // `background-acquire`, …).
  layer: z.string(),
  // What the lead waiter waited for (runtime-profiler's `WaitKind`): `queue`
  // — capacity on the gate. A plain string: persisted data.
  waitKind: z.string(),
  // How long the longest waiter had been queued — a lower bound, filed once.
  waitedMs: z.number(),
  // The gate's occupancy when the watchdog looked, or null for a gate that
  // registers no gauge.
  occupancy: z
    .object({
      active: z.number(),
      queued: z.number(),
      max: z.number(),
    })
    .nullable(),
  // Who held it, longest first, at most `GATE_HOLDERS_MAX`. Empty when the
  // gate names none (its callers carry no label) or nothing held it.
  holders: z.array(GateHolderSchema),
  // The operations queued, most runs first, at most `GATE_WAITERS_MAX`.
  waiters: z.array(GateWaiterSchema),
});
export type StuckGate = z.infer<typeof StuckGateSchema>;

// The most holders / waiting operations a gate report lists.
export const GATE_HOLDERS_MAX = 8;
export const GATE_WAITERS_MAX = 10;

// The jsonb payload of a `span-stuck` report: one operation that was still
// running past its kind's threshold when the watchdog looked.
//
// Filed ONCE per operation per watchdog tick: the runs of one operation found
// stuck on the same tick are one finding (`runs` of them, `spanId` the oldest)
// — 121 subscriptions of one resource queued behind the same blocked gate are
// one cause, not 121 reports. Deduped onto one row per operation (`kind` +
// `label`), so a row's `count` reads "how many separate times this operation
// was found newly stuck".
export const StuckSpanPayloadSchema = z.object({
  // The runtime profiler's per-run id of the stuck span. Names the exact run in
  // the attached trace's flight window.
  spanId: z.number().int(),
  kind: z.string(),
  label: z.string(),
  // How long it had been running when the watchdog filed it — a lower bound on
  // how long it was stuck, since it is filed once and never re-measured.
  ageMs: z.number(),
  // The threshold for this kind it had crossed.
  thresholdMs: z.number(),
  // How many runs of this operation were found newly stuck on the same tick
  // (`spanId` / `ageMs` / `ancestors` describe the oldest). Absent on rows
  // filed before runs were grouped: one run each.
  runs: z.number().int().min(1).optional(),
  // The chain of still-open ancestors this span ran inside, OUTERMOST first,
  // ending at its immediate parent. Empty for a top-level span, and cut short
  // where a parent had already closed.
  ancestors: z.array(StuckAncestorSchema),
  // Present when the finding is a gate not admitting its waiters (`spanId` /
  // `kind` / `label` / `ancestors` then describe the longest waiter, `runs`
  // counts every waiter): see `StuckGateSchema`. Absent: the span is stuck in
  // its own work — and on every row filed before gate waits were told apart.
  gate: StuckGateSchema.optional(),
  // The coherent-instant trace of everything in flight at detection (Debug →
  // Slow Events), or null when the trace engine did not admit one (disabled,
  // or the same trigger inside its cooldown). A state, never a missing field.
  traceId: z.string().nullable(),
});
export type StuckSpanPayload = z.infer<typeof StuckSpanPayloadSchema>;
