import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { MAX_EMIT_RATE, EmitStatusSchema } from "../core";

// EmitStatusSchema lives in core/ because the window-level global API — whose
// methods all resolve to an EmitStatus — is a contract shared with the e2e
// driver, and e2e may import core but not shared. See core/global-api.ts.
export { EmitStatusSchema };
export type { EmitStatus } from "../core";

export const startEmit = defineEndpoint({
  route: "POST /api/debug/live-state-emit/start",
  body: z.object({
    key: z.string(),
    rate: z.number().min(0.1).max(MAX_EMIT_RATE),
    durationMs: z.number().positive().optional(),
  }),
  response: EmitStatusSchema,
});

export const stopEmit = defineEndpoint({
  route: "POST /api/debug/live-state-emit/stop",
  response: EmitStatusSchema,
});

// The status as one request/response read, for the window-level imperative
// API's `status()` (the headless e2e driver's handle). The pane reads the live
// `live-state-emit.status` value instead (shared/resources.ts).
export const getEmitStatus = defineEndpoint({
  route: "GET /api/debug/live-state-emit/status",
  response: EmitStatusSchema,
  dedupe: true,
});
