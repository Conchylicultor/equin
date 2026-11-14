import { z } from "zod";

// The jsonb payload for a `live-state-noop` report. One report per distinct
// resource key (fingerprint `live-state-noop:<resourceKey>`), so a sustained
// churn on one resource collapses to a single task. Carries the per-key rollup
// over the trailing window: how many no-op (empty-diff) recomputes ran vs total
// pushes, their rate, the subscribers they reached, and — what the report is
// judged on — the work they wasted.
//
// The `wasted*` fields are absent on reports filed before the detector measured
// cost (it then judged by rate alone); a reader shows them as unmeasured.
export const LiveStateNoopPayloadSchema = z.object({
  resourceKey: z.string(),
  noopRate: z.number(),
  noopCount: z.number().int(),
  totalCount: z.number().int(),
  subscribers: z.number().int(),
  windowSeconds: z.number().int(),
  /** Work wasted per minute: `(wastedOwnMs + wastedIoMs)` scaled to 60 s — the judged measure. */
  wastedMsPerMinute: z.number().optional(),
  /** The no-op recomputes' own work over the window (server thread + database), ms. */
  wastedOwnMs: z.number().optional(),
  /** The git / file io they waited on over the window, ms. */
  wastedIoMs: z.number().optional(),
  /** Every wait over the window (io included) — queued on a gate or joined another run beyond the io; not judged, ms. */
  wastedWaitMs: z.number().optional(),
});
export type LiveStateNoopPayload = z.infer<typeof LiveStateNoopPayloadSchema>;

/** The report's one-line summary of what a no-op churn wastes, shared by the message, the task and the Reports row. */
export function describeNoopWaste(d: LiveStateNoopPayload): string {
  const rate = `~${d.noopRate.toFixed(1)} no-op pushes/s (×${d.noopCount}/${d.windowSeconds}s)`;
  if (d.wastedMsPerMinute === undefined) return `${rate}, cost not measured`;
  const parts = [`own ${ms(d.wastedOwnMs)}`];
  if ((d.wastedIoMs ?? 0) > 0) parts.push(`io ${ms(d.wastedIoMs)}`);
  let detail = `over ${d.windowSeconds}s: ${parts.join(", ")}`;
  const other = (d.wastedWaitMs ?? 0) - (d.wastedIoMs ?? 0);
  if (other >= 1) detail += `; ${ms(other)} queued/joined, not counted`;
  return `~${Math.round(d.wastedMsPerMinute)} ms/min of wasted work (${detail}) · ${rate}`;
}

function ms(v: number | undefined): string {
  return `${Math.round(v ?? 0)} ms`;
}
