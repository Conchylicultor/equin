import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

// What fills the agent's context window right now, as the harness itself
// measures it (the Agent SDK's `getContextUsage()`, the data behind `/context`).
// Only the fields a surface reads are parsed; the SDK evolves its shape
// additively, so unknown fields are dropped rather than refused.

/**
 * One row of the breakdown. `kind` classifies it, never its English name:
 * `used` occupies the window, `free` is what is left, `buffer` is the reserve
 * the harness keeps for compacting, `deferred` are tool schemas outside the
 * window (listed by the harness, excluded from its usage math).
 */
export const ContextCategorySchema = z.object({
  name: z.string(),
  tokens: z.number(),
  kind: z.enum(["used", "free", "buffer", "deferred"]),
});
export type ContextCategory = z.infer<typeof ContextCategorySchema>;

export const ContextUsageSchema = z.object({
  model: z.string(),
  totalTokens: z.number(),
  /** The window usage is measured against (the harness's resolved window). */
  rawMaxTokens: z.number(),
  /** Where the harness compacts on its own; absent when it does not say. */
  autoCompactThreshold: z.number().optional(),
  isAutoCompactEnabled: z.boolean(),
  categories: z.array(ContextCategorySchema),
  memoryFiles: z.array(z.object({ path: z.string(), tokens: z.number() })),
  mcpTools: z.array(
    z.object({
      name: z.string(),
      serverName: z.string(),
      tokens: z.number(),
      isLoaded: z.boolean().optional(),
    }),
  ),
  messageBreakdown: z
    .object({
      toolCallTokens: z.number(),
      toolResultTokens: z.number(),
      attachmentTokens: z.number(),
      assistantMessageTokens: z.number(),
      userMessageTokens: z.number(),
    })
    .optional(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

/**
 * A conversation's context reading: the harness's own numbers, or why there
 * are none — no agent process is running (a hibernated or finished
 * conversation), or the running one predates the command.
 */
export const ContextReadingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), usage: ContextUsageSchema }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["not-running", "unsupported"]),
  }),
]);
export type ContextReading = z.infer<typeof ContextReadingSchema>;

/**
 * A conversation's context reading, re-measured whenever its conversation row
 * moves (a turn starting or ending, a compaction). Served by
 * `conversations/machine` through the conversation's runtime.
 */
export const conversationContextUsage = liveValue(
  "conversations.context-usage",
  {
    schema: ContextReadingSchema,
    params: ["id"],
    // The reading comes from the agent process, on the computer.
    needsMachine: { feature: "Showing what fills the agent's context" },
  },
);
