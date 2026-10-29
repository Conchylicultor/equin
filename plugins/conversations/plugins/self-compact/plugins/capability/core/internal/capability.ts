import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * May compact its own context (`compact_context`): after a major step, the
 * agent says what to keep and what to do next, and the app compacts it once
 * its turn ends. `true` only — no grant, no tool.
 */
export const contextCompact = defineCapability<true>({
  id: "context.compact",
  schema: z.literal(true),
  label: "Compact its own context",
});
