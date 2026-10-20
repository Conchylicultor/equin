import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// The partial message on the wire: the agent folds the SDK's `stream_event`s
// into frames (never written to events.jsonl) and streams them to a backend
// that subscribes; both sides fold the same frames with `applyPartialFrame`,
// so they cannot disagree.
//
// The message's shape is the conversations domain's `PartialMessage`, restated
// here rather than imported: bin/agent.ts loads this barrel, and the
// conversations barrel would add its whole closure to every agent's cold
// start. The machine half hands this to the runtime contract, so tsc holds the
// two shapes together.

const PartialMessageSchema = z.object({
  messageId: z.string(),
  blocks: z.array(z.object({ index: z.number().int(), text: z.string() })),
});
export type PartialMessage = z.infer<typeof PartialMessageSchema>;

/**
 * One change to the partial message:
 * - `start` — a new message began (the previous one is finished);
 * - `delta` — text appended to one block;
 * - `clear` — the message will never land (interrupted, failed): drop it.
 */
export const PartialFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), messageId: z.string() }),
  z.object({
    type: z.literal("delta"),
    index: z.number().int(),
    text: z.string(),
  }),
  z.object({ type: z.literal("clear") }),
]);
export type PartialFrame = z.infer<typeof PartialFrameSchema>;

/**
 * What the agent writes on a `subscribe` connection after its reply (which is
 * the current message, `PartialMessage | null`): one frame per line.
 */
export const PartialStreamLineSchema = z.object({ frame: PartialFrameSchema });

/** `subscribe`'s reply: the message being streamed when the subscriber joined. */
export const SubscribeReplySchema = PartialMessageSchema.nullable();

export function applyPartialFrame(
  state: PartialMessage | null,
  frame: PartialFrame,
): PartialMessage | null {
  switch (frame.type) {
    case "start":
      return { messageId: frame.messageId, blocks: [] };
    case "clear":
      return null;
    case "delta": {
      // A delta with no message started (a subscriber joining mid-way gets the
      // snapshot first, so this is a broken stream) is loud.
      if (!state)
        throw new Error("partial text: a delta arrived before any message");
      const has = state.blocks.some((b) => b.index === frame.index);
      return {
        messageId: state.messageId,
        blocks: has
          ? state.blocks.map((b) =>
              b.index === frame.index
                ? { index: b.index, text: b.text + frame.text }
                : b,
            )
          : [...state.blocks, { index: frame.index, text: frame.text }],
      };
    }
  }
}

/**
 * The frame one SDK stream event makes, or null when it changes no visible
 * text (other event kinds, thinking and tool input, a sub-agent's stream).
 * Typed by the pinned SDK, so an upgrade that changes the stream fails here.
 */
export function partialFrameOf(
  msg: SDKPartialAssistantMessage,
): PartialFrame | null {
  if (msg.parent_tool_use_id !== null) return null;
  const e = msg.event;
  switch (e.type) {
    case "message_start":
      return { type: "start", messageId: e.message.id };
    case "content_block_start":
      // A text block opens empty in practice; carry any initial text anyway.
      return e.content_block.type === "text" && e.content_block.text
        ? { type: "delta", index: e.index, text: e.content_block.text }
        : null;
    case "content_block_delta":
      return e.delta.type === "text_delta" && e.delta.text
        ? { type: "delta", index: e.index, text: e.delta.text }
        : null;
    // The message ending, its usage, a block closing: no text. Named, not
    // defaulted, so a new event kind in an SDK upgrade is a decision here.
    case "content_block_stop":
    case "message_delta":
    case "message_stop":
      return null;
  }
}
