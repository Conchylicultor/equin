import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

// Partial text: what the model has written so far of the message it is
// streaming, before the CLI writes the finished message to the transcript.
// The page draws it as a temporary block and drops it once the transcript's
// line for the same message id holds its text. Held in memory only: a backend
// restart mid-message loses it, the finished message still arrives.

/** One text block of the streaming message, by its content-block index. */
export const PartialBlockSchema = z.object({
  index: z.number().int(),
  text: z.string(),
});
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
    // The text lives in the agent process, on the computer.
    needsMachine: { feature: "Showing the agent's reply as it is written" },
  },
);
