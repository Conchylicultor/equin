import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ClientBootSectionSchema } from "@plugins/debug/plugins/trace/plugins/client-boot/core";
import { CallerRefSchema, MAX_CLIENT_SLOW_OP_ITEMS } from "../core";

// The wait layer an `element` settle charges its transport bring-up to: the
// notifications socket was not ready when the resource mounted.
export const TRANSPORT_LAYER = "notifications-transport";

// One client-side slow-op signal. `operationKind` is "page-load", "element",
// or a client latency signal from perfs/latency-signal ("update", "confirm",
// …) — an open string, so a new signal needs no schema change here. A client
// origin has no enclosing server span, so every signal but page-load supplies
// its own caller — the route that issued it ({ kind: "route", label: pathname })
// — for caller attribution. The server stamps the worktree; the client only
// supplies the measurement.
export const SlowOpClientItemSchema = z.object({
  operationKind: z.string(),
  operation: z.string(),
  durationMs: z.number(),
  thresholdMs: z.number(),
  caller: CallerRefSchema.optional(),
  // Per-layer split of `durationMs` (layer → ms), merged into the row's durable
  // `waits` exactly like a server span's gate waits. A latency signal sends its
  // phases here; `element` charges its transport bring-up to
  // `notifications-transport`.
  waits: z.record(z.string(), z.number()).optional(),
  // Which instance of the operation ran, without splitting the row: merged into
  // the row's `variants` breakdown (a latency signal's params, or a confirm's
  // `mode/edge`). The `operation` stays a bounded resource key.
  detail: z.object({ variant: z.string().optional() }).optional(),
  // Additive, backward-compatible cold-start flag for the `element` signal:
  // the notifications transport was not ready when the resource mounted, so
  // the settle reads as transport time-to-first-data, not resource compute.
  // Kept beside `waits` because it drives the report title.
  transportColdStart: z.boolean().optional(),
  // Additive, backward-compatible client evidence for the `page-load` signal
  // (absent for the others and older clients): the browser's own boot
  // decomposition (perfs/boot-trace), trimmed by toClientBootSection so the
  // keepalive beacon stays small. The handler threads it into the page-load
  // trigger's detail, where the client-boot trace class validates and persists
  // it; recordSlowOp never sees it.
  clientBoot: ClientBootSectionSchema.optional(),
});
export type SlowOpClientItem = z.infer<typeof SlowOpClientItemSchema>;

// The beacon carries a BATCH. One POST per slow element amplified the very
// stall it reported (438 calls / 43.2s of server time in one 24s incident —
// research/2026-09-02-global-alert-fan-out-ceiling.md), so the browser queue
// debounces and chunks instead. `dropped` is how many items the queue had to
// discard under its own cap since the last batch: the loss is reported, never
// silent. Deliberately NOT backward-compatible with the old single-item body —
// a stale tab's beacon 400s silently, which is the right outcome for a
// `report: false` telemetry beacon.
export const SlowOpClientBodySchema = z.object({
  items: z.array(SlowOpClientItemSchema).min(1).max(MAX_CLIENT_SLOW_OP_ITEMS),
  dropped: z.number().optional(),
});
export type SlowOpClientBody = z.infer<typeof SlowOpClientBodySchema>;

export const submitClientSlowOp = defineEndpoint({
  route: "POST /api/slow-ops/client",
  body: SlowOpClientBodySchema,
  response: z.object({ ok: z.boolean() }),
});
