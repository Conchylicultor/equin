import { z } from "zod";

// The jsonb payload for the "slow-op" report. The report fingerprint keys on
// (operationKind, operation), so each distinct slow op owns its own report; the
// payload carries that op's identity plus its latest tripping duration —
// fingerprint, task title/description, and message all read from it. The full
// ranked breakdown (totals, max, caller attribution) lives in the slow_ops store
// / Debug → Slow Ops, which each report points into.
export const SlowOpReportPayloadSchema = z.object({
  operationKind: z.string(),
  operation: z.string(),
  durationMs: z.number(),
  // The operation's own time — what was judged against `thresholdMs` (see
  // "Own time" in CLAUDE.md). Absent on reports filed before it existed, which
  // judged the wall `durationMs`.
  ownMs: z.number().optional(),
  thresholdMs: z.number(),
  // Optional, backward-compatible cold-start attribution (element signal only).
  // Stored in the report's jsonb `data`, so no migration. When present and true,
  // renderTask/renderDescription append that the measured duration was
  // transport bring-up (time-to-first-data), not this resource's own compute —
  // pointing the investigation at transport/boot readiness, not the resource.
  transportColdStart: z.boolean().optional(),
  // Pre-`waits` spelling of the cold-start wait, kept so reports filed before
  // the move still parse and render. New reports carry it as
  // `waits["notifications-transport"]`.
  transportWaitMs: z.number().optional(),
  // The tripping occurrence's per-layer split (layer → ms): a server span's gate
  // waits, a client latency signal's phases, an element's transport bring-up.
  // The description names its largest layer.
  waits: z.record(z.string(), z.number()).optional(),
  // The durable trace captured for the trip that filed this report (when the
  // engine admitted one). Stored in the jsonb `data` (no migration) so the
  // slow-op KindView / renderTask can deep-link the coherent-instant evidence.
  traceId: z.string().optional(),
  // Present on a `burst` report (operation `burst`): several ops of this kind
  // tripped in one batch — one incident — so ONE report stands for them all,
  // carrying its slowest op's measurement. `operations` names the slowest few
  // (`BURST_NAMED_CAP`), `count` all of them.
  burst: z
    .object({
      count: z.number(),
      operations: z.array(
        z.object({ operation: z.string(), ownMs: z.number() }),
      ),
    })
    .optional(),
});
export type SlowOpReportPayload = z.infer<typeof SlowOpReportPayloadSchema>;
