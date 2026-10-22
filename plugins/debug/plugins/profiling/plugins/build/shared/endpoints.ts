import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const SpanSchema = z.object({
  id: z.string(),
  phase: z.string(),
  label: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  // Peak RSS (bytes) of the subprocess the span wrapped, when measured.
  maxRssBytes: z.number().optional(),
});

// Read from the worktree's build artifacts on the computer's disk.
export const getBuildRunProfileByWorktree = defineEndpoint({
  route: "GET /api/debug/profiling/build/:worktree/:buildId",
  response: z.object({
    spans: z.array(SpanSchema),
    totalMs: z.number(),
  }),
  needsMachine: { feature: "Build profiles" },
});
