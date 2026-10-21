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

const TextBlockSchema = z.object({
  kind: z.literal("text"),
  index: z.number().int(),
  text: z.string(),
});
const ThinkingBlockSchema = z.object({
  kind: z.literal("thinking"),
  index: z.number().int(),
  text: z.string(),
});
const ToolUseBlockSchema = z.object({
  kind: z.literal("tool_use"),
  index: z.number().int(),
  toolUseId: z.string(),
  name: z.string(),
  /** The tool input's JSON as written so far — a prefix, not a document. */
  inputJson: z.string(),
});

/**
 * One block of the message. An agent started before blocks had kinds holds
 * text blocks without one: its snapshot reads as text.
 */
const PartialBlockSchema = z.preprocess(
  (raw) =>
    typeof raw === "object" && raw !== null && !("kind" in raw)
      ? { ...raw, kind: "text" }
      : raw,
  z.discriminatedUnion("kind", [
    TextBlockSchema,
    ThinkingBlockSchema,
    ToolUseBlockSchema,
  ]),
);
export type PartialBlock = z.infer<typeof PartialBlockSchema>;

const PartialMessageSchema = z.object({
  messageId: z.string(),
  blocks: z.array(PartialBlockSchema),
});
export type PartialMessage = z.infer<typeof PartialMessageSchema>;

/** What `open` says about a block before its first delta. */
const OpenedBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thinking") }),
  z.object({
    kind: z.literal("tool_use"),
    toolUseId: z.string(),
    name: z.string(),
  }),
]);

/**
 * One change to the partial message:
 * - `start` — a new message began (the previous one is finished);
 * - `open` — a thinking or tool-use block began (a text block needs none: a
 *   delta for a block never opened is text, which is all an agent started
 *   before blocks had kinds ever sends);
 * - `delta` — text appended to one block (its text, or its tool input's JSON);
 * - `clear` — the message will never land (interrupted, failed): drop it.
 */
export const PartialFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), messageId: z.string() }),
  z.object({
    type: z.literal("open"),
    index: z.number().int(),
    block: OpenedBlockSchema,
  }),
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

/** `block` with `text` appended to what it holds. */
function appended(block: PartialBlock, text: string): PartialBlock {
  return block.kind === "tool_use"
    ? { ...block, inputJson: block.inputJson + text }
    : { ...block, text: block.text + text };
}

export function applyPartialFrame(
  state: PartialMessage | null,
  frame: PartialFrame,
): PartialMessage | null {
  switch (frame.type) {
    case "start":
      return { messageId: frame.messageId, blocks: [] };
    case "clear":
      return null;
    case "open": {
      if (!state)
        throw new Error("partial message: a block opened before any message");
      if (state.blocks.some((b) => b.index === frame.index))
        throw new Error(`partial message: block ${frame.index} opened twice`);
      const block: PartialBlock =
        frame.block.kind === "thinking"
          ? { kind: "thinking", index: frame.index, text: "" }
          : {
              kind: "tool_use",
              index: frame.index,
              toolUseId: frame.block.toolUseId,
              name: frame.block.name,
              inputJson: "",
            };
      return { messageId: state.messageId, blocks: [...state.blocks, block] };
    }
    case "delta": {
      // A delta with no message started (a subscriber joining mid-way gets the
      // snapshot first, so this is a broken stream) is loud.
      if (!state)
        throw new Error("partial message: a delta arrived before any message");
      const has = state.blocks.some((b) => b.index === frame.index);
      return {
        messageId: state.messageId,
        blocks: has
          ? state.blocks.map((b) =>
              b.index === frame.index ? appended(b, frame.text) : b,
            )
          : [
              ...state.blocks,
              { kind: "text", index: frame.index, text: frame.text },
            ],
      };
    }
  }
}

type BlockDelta = Extract<
  SDKPartialAssistantMessage["event"],
  { type: "content_block_delta" }
>["delta"];

/** The frame one block delta makes, or null when it adds nothing a reader sees. */
function deltaFrameOf(index: number, d: BlockDelta): PartialFrame | null {
  switch (d.type) {
    case "text_delta":
      return d.text ? { type: "delta", index, text: d.text } : null;
    case "thinking_delta":
      return d.thinking ? { type: "delta", index, text: d.thinking } : null;
    case "input_json_delta":
      return d.partial_json
        ? { type: "delta", index, text: d.partial_json }
        : null;
    // The thinking's signature, a citation's anchor, a compaction's
    // bookkeeping: nothing a reader sees.
    case "signature_delta":
    case "citations_delta":
    case "compaction_delta":
      return null;
  }
}

/**
 * The frame one SDK stream event makes, or null when it changes nothing the
 * page draws (a signature, citations, a block closing, a server tool's block,
 * a sub-agent's stream). Typed by the pinned SDK, so an upgrade that changes
 * the stream fails here.
 */
export function partialFrameOf(
  msg: SDKPartialAssistantMessage,
): PartialFrame | null {
  if (msg.parent_tool_use_id !== null) return null;
  const e = msg.event;
  switch (e.type) {
    case "message_start":
      return { type: "start", messageId: e.message.id };
    case "content_block_start": {
      const block = e.content_block;
      switch (block.type) {
        case "thinking":
          return { type: "open", index: e.index, block: { kind: "thinking" } };
        case "tool_use":
          return {
            type: "open",
            index: e.index,
            block: { kind: "tool_use", toolUseId: block.id, name: block.name },
          };
        case "text":
          // A text block opens empty in practice; carry any initial text anyway.
          return block.text
            ? { type: "delta", index: e.index, text: block.text }
            : null;
        // Redacted thinking has nothing to show; the rest are server-side
        // tools' calls and results, or API bookkeeping, which the transcript
        // does not draw as rows of the message. Named, not defaulted, so a new
        // block kind in an SDK upgrade is a decision here.
        case "redacted_thinking":
        case "server_tool_use":
        case "mcp_tool_use":
        case "mcp_tool_result":
        case "mcp_tool_listing":
        case "web_search_tool_result":
        case "web_fetch_tool_result":
        case "code_execution_tool_result":
        case "bash_code_execution_tool_result":
        case "text_editor_code_execution_tool_result":
        case "tool_search_tool_result":
        case "advisor_tool_result":
        case "container_upload":
        case "compaction":
        case "fallback":
          return null;
      }
    }
    case "content_block_delta":
      return deltaFrameOf(e.index, e.delta);
    // The message ending, its usage, a block closing: nothing to draw. Named,
    // not defaulted, so a new event kind in an SDK upgrade is a decision here.
    case "content_block_stop":
    case "message_delta":
    case "message_stop":
      return null;
  }
}
