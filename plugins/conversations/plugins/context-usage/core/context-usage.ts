import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// What fills the agent's context window, as the harness itself
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
  categories: wholeList(ContextCategorySchema, {
    reason:
      "the harness's own breakdown of one context window: a handful of categories",
  }),
  memoryFiles: wholeList(z.object({ path: z.string(), tokens: z.number() }), {
    reason: "the CLAUDE.md / memory files one agent loaded: a handful",
  }),
  mcpTools: wholeList(
    z.object({
      name: z.string(),
      serverName: z.string(),
      tokens: z.number(),
      isLoaded: z.boolean().optional(),
    }),
    {
      reason:
        "the MCP tools one agent process was handed: tens, fixed by its config",
    },
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

// The `conversations_ext_context_usage` row: a conversation's LAST context
// reading, as its agent measured it. The agent measures itself and the
// runtime records it here (`recordContextUsage`, its server half) — the
// SDK agent once its CLI is ready and after every turn (a compaction ends
// one), written as an event in the stream the runtime already applies. No
// reader ever asks the agent: a busy or starved agent leaves its last reading
// in place rather than failing every read, and a stopped one keeps the window
// it will resume with.
export const conversationContextShape = defineExtensionShape({
  key: "conversationId",
  fields: { usage: jsonField({ schema: ContextUsageSchema }) },
  wireTimestamps: ["updatedAt"],
});
export type ConversationContext = z.infer<
  typeof conversationContextShape.schema
>;

/**
 * One conversation's last context reading, by its id — lookup-only (nothing
 * lists every conversation's window): `useLive(conversationContextUsage,
 * { id })`, where `found: false` is "no reading yet" (an agent that has not
 * reported one — started before agents measured themselves, or not yet
 * ready). A load is one primary-key seek, and a reading reaches only its own
 * conversation's readers.
 */
export const conversationContextUsage = liveCollection(
  "conversations.context-usage",
  { from: conversationContextShape, id: "conversationId" },
);
