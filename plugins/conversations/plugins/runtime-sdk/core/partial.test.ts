import { describe, expect, test } from "bun:test";
import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  applyPartialFrame,
  partialFrameOf,
  type PartialMessage,
} from "./partial";

/**
 * A stream event carrying only the fields the fold reads — the real ones
 * hold whole API objects (usage, citations, …) the fold never looks at.
 */
const ev = (
  event: Record<string, unknown>,
  parent: string | null = null,
): SDKPartialAssistantMessage =>
  ({
    type: "stream_event",
    parent_tool_use_id: parent,
    uuid: crypto.randomUUID(),
    session_id: "s",
    event,
  }) as unknown as SDKPartialAssistantMessage;

const text = (index: number, t: string) =>
  ev({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text: t },
  });

/** Fold a stream as the agent does, frame by frame. */
function fold(events: SDKPartialAssistantMessage[]): PartialMessage | null {
  let state: PartialMessage | null = null;
  for (const e of events) {
    const frame = partialFrameOf(e);
    if (frame) state = applyPartialFrame(state, frame);
  }
  return state;
}

describe("the partial message", () => {
  test("text deltas accumulate per block; tool input and thinking are not text", () => {
    expect(
      fold([
        ev({ type: "message_start", message: { id: "msg_1" } }),
        ev({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        }),
        ev({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta" },
        }),
        ev({
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        }),
        text(1, "Hel"),
        text(1, "lo"),
        ev({
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use" },
        }),
        ev({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta" },
        }),
        ev({ type: "message_stop" }),
      ]),
    ).toEqual({ messageId: "msg_1", blocks: [{ index: 1, text: "Hello" }] });
  });

  test("a new message replaces the previous one", () => {
    expect(
      fold([
        ev({ type: "message_start", message: { id: "msg_1" } }),
        text(0, "a"),
        ev({ type: "message_start", message: { id: "msg_2" } }),
        text(0, "b"),
      ]),
    ).toEqual({ messageId: "msg_2", blocks: [{ index: 0, text: "b" }] });
  });

  test("a sub-agent's stream is not the conversation's message", () => {
    expect(
      fold([
        ev({ type: "message_start", message: { id: "msg_1" } }, "toolu_1"),
        ev(
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "a" },
          },
          "toolu_1",
        ),
      ]),
    ).toBeNull();
  });

  test("clear drops the message; a delta with no message is loud", () => {
    const state = applyPartialFrame(null, { type: "start", messageId: "m" });
    expect(applyPartialFrame(state, { type: "clear" })).toBeNull();
    expect(() =>
      applyPartialFrame(null, { type: "delta", index: 0, text: "x" }),
    ).toThrow();
  });
});
