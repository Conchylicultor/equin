import { z } from "zod";
import {
  StallLeafSchema,
  StallScopeSchema,
  StallStackSchema,
} from "@plugins/debug/plugins/trace/plugins/stall/core";

// The jsonb payload for an `event-loop-stall` report — the alert-funnel twin of
// the `stall` trace. One report per distinct freeze cause (fingerprint
// `event-loop-stall:<culpritStack>`), so a recurring identical freeze collapses
// onto one row whose `count` is "how many times this stack froze the loop".
//
// Everything here is DERIVED from the existing `StallSection` (the trace
// evidence) at report time — `StallSection` stays purely the stack evidence, and
// the presentation grain (`culpritStack` / `hotFrame`) is computed in this plugin
// (see server/internal/culprit.ts). `topLeaves` / `topStacks` reuse the section's
// shapes verbatim (imported, never redeclared) so the report and the trace can
// never disagree on the histogram shape.
export const StallPayloadSchema = z.object({
  durationMs: z.number(),
  thresholdMs: z.number(),
  nSamples: z.number(),
  sampleRateHz: z.number(),
  // What the samples cover — the block's own, or (no registered block placed)
  // the whole window's — and how long that span was; the window's sample rate
  // beside the block's (StallSection). Optional ⇒ rows filed before this was
  // recorded, all window-scoped.
  scope: StallScopeSchema.optional(),
  spanMs: z.number().optional(),
  windowSampleRateHz: z.number().optional(),
  // The dominant caller-path signature (topStacks[0].stack) — THE dedup grain.
  culpritStack: z.string(),
  // The human-readable label derived from THAT stack's own frames (`what ←
  // where`) — shown in the summary and the task title. NOT the fingerprint.
  hotFrame: z.string(),
  topLeaves: z.array(StallLeafSchema),
  topStacks: z.array(StallStackSchema),
  // Deep-link into the coherent-instant stall trace (Debug → Slow Events) when
  // captureTrace admitted one.
  traceId: z.string().optional(),
  // Coverage classification (Layer 4): `true` ⇒ NO tracked span covered this
  // freeze, so `get_runtime_profile` / `slow_ops` / `byParent` are all blind to
  // it and this report is the only surface that names it. `false` ⇒ some entry
  // span was open across it (the cost landed in that span's selfMs, a traceable
  // victim), named by `coveringSpan`. Optional ⇒ back-compat with pre-Layer-4
  // rows.
  unspanned: z.boolean().optional(),
  coveringSpan: z
    .object({ kind: z.string(), label: z.string() })
    .optional(),
});
export type StallPayload = z.infer<typeof StallPayloadSchema>;
