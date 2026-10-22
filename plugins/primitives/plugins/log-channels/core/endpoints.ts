import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Max lines accepted per emit request. Shared so the client chunks its flush to
// this size and can never form a batch the server will reject (see client-log.ts).
export const MAX_EMIT_LINES = 500;

export const EmitLogsBodySchema = z.object({
  channel: z.string().min(1).max(128),
  lines: z
    .array(
      z.object({
        line: z.string(),
        stream: z.enum(["stdout", "stderr"]).optional(),
        t: z.number(), // client emit time (ms) — preserved on disk
      }),
    )
    .min(1)
    .max(MAX_EMIT_LINES),
});
export type EmitLogsBody = z.infer<typeof EmitLogsBodySchema>;

// Whether the server took the batch. `paused` is backpressure (the host duress
// latch is set): the batch was NOT ingested and the client must re-queue it and
// back off. It is a 200 with a typed arm rather than an HTTP error status on
// purpose — the browser prints "Failed to load resource" for every non-2xx
// response, so an error status would fill the console with noise for the whole
// duress episode, about a refusal that is expected and lossless.
export const EmitLogsResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }),
  z.object({ status: z.literal("paused"), reason: z.literal("duress") }),
]);
export type EmitLogsResult = z.infer<typeof EmitLogsResultSchema>;

export const emitLogs = defineEndpoint({
  route: "POST /api/logs/emit",
  // Log lines only: an agent session's browser logs like a user's (main is
  // read-only for agents otherwise).
  agentWrite: "telemetry",
  body: EmitLogsBodySchema,
  response: EmitLogsResultSchema,
  // One batch is one ring trim plus one file write, so this route has no honest
  // reason to take even a fraction of a second. Declaring the bar means a future
  // regression here NAMES this route in slow-ops instead of surfacing as an
  // anonymous event-loop stall in a profile — which is exactly how the per-line
  // write loop this batching replaced was found.
  slowThresholdMs: 300,
});
