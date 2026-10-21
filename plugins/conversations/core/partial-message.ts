import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

// The partial message: what the model has written so far of the message it
// is streaming — its thinking, text and tool calls — before the CLI writes
// each finished block to the transcript. The page draws each block as a
// stand-in for its row and drops it once the transcript holds that block.
// Held in memory only: a backend restart mid-message loses it, the finished
// message still arrives.

/** One block of the streaming message, by its content-block index. */
export const PartialBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    index: z.number().int(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("thinking"),
    index: z.number().int(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("tool_use"),
    index: z.number().int(),
    /** The call's id (`toolu_…`) — the transcript event's `toolUseId`. */
    toolUseId: z.string(),
    name: z.string(),
    /** The input's JSON as written so far: a prefix, not a document. */
    inputJson: z.string(),
  }),
]);
export type PartialBlock = z.infer<typeof PartialBlockSchema>;

/** The main agent's message being streamed (a sub-agent's is not). */
export const PartialMessageSchema = z.object({
  /** The API message id (`msg_…`) — the transcript event's `messageId`. */
  messageId: z.string(),
  blocks: z.array(PartialBlockSchema),
});
export type PartialMessage = z.infer<typeof PartialMessageSchema>;

/**
 * A conversation's streaming message; null when none is being written.
 * Served by `conversations/machine` through the conversation's runtime.
 */
export const conversationPartialMessage = liveValue(
  "conversations.partial-message",
  {
    schema: PartialMessageSchema.nullable(),
    params: ["id"],
    // It grows by a few characters per push, up to a whole file's worth of
    // tool input: each push ships only what was written since.
    patches: true,
    // The text lives in the agent process, on the computer.
    needsMachine: { feature: "Showing the agent's reply as it is written" },
  },
);
