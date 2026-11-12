import { z } from "zod";
import { InteractionSchema } from "@plugins/debug/plugins/latency-ledger/core";

// The jsonb payload of a `client-rate` report: one browser tab (`clientId`, its
// session-scoped id — the same across its reloads) loaded (or navigated to)
// `route` `count` times in the clock hour so far, where a client usually does
// one route at most `usual` times in an hour (the 99th percentile of the
// `historyClientHours` client-route-hours of the last 7 days), past `threshold`. `automated`: the tab was
// driven by automation (the agent browser, an e2e run) — marked, never muted.
export const ClientRatePayloadSchema = z.object({
  interaction: InteractionSchema.shape.kind,
  clientId: z.string(),
  route: z.string(),
  automated: z.boolean(),
  count: z.number().int(),
  /** ISO start of the clock hour counted. */
  hourStart: z.string(),
  usual: z.number().int(),
  threshold: z.number().int(),
  historyClientHours: z.number().int(),
  /** Everywhere the tab went this hour (this kind), busiest first: a loop between routes shows here. */
  topRoutes: z
    .array(z.object({ route: z.string(), count: z.number().int() }))
    .max(5),
});
export type ClientRatePayload = z.infer<typeof ClientRatePayloadSchema>;
