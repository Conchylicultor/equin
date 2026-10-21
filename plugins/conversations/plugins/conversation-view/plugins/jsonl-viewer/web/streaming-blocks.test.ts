import { describe, expect, test } from "bun:test";
import type { PartialBlock } from "@plugins/conversations/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { standInsOf } from "./streaming-blocks";

const AT = "2026-10-21T00:00:00Z";

const text = (messageId: string, t: string): JsonlEvent => ({
  kind: "assistant-text",
  at: AT,
  messageId,
  text: t,
});
const thinking = (messageId: string): JsonlEvent => ({
  kind: "assistant-thinking",
  at: AT,
  messageId,
  thinking: "…",
});
const call = (messageId: string, toolUseId: string): JsonlEvent => ({
  kind: "tool-call",
  at: AT,
  messageId,
  toolUseId,
  name: "Write",
  input: {},
});

const drawn = (
  blocks: PartialBlock[],
  events: JsonlEvent[] = [],
  messageId = "m1",
) => standInsOf({ messageId, blocks }, events, AT).map((s) => s.event);

describe("standInsOf", () => {
  test("every kind is drawn as the event its row will be, in block order", () => {
    expect(
      drawn([
        {
          kind: "tool_use",
          index: 2,
          toolUseId: "t1",
          name: "Write",
          inputJson: '{"file_path":"/a.ts","content":"he',
        },
        { kind: "thinking", index: 0, text: "Hmm" },
        { kind: "text", index: 1, text: "Hello" },
      ]),
    ).toEqual([
      { kind: "assistant-thinking", at: AT, messageId: "m1", thinking: "Hmm" },
      { kind: "assistant-text", at: AT, messageId: "m1", text: "Hello" },
      {
        kind: "tool-call",
        at: AT,
        messageId: "m1",
        toolUseId: "t1",
        name: "Write",
        input: { file_path: "/a.ts", content: "he" },
      },
    ]);
  });

  test("a thinking block, even empty, is drawn; a blank text block is not", () => {
    expect(
      drawn([
        { kind: "thinking", index: 0, text: "" },
        { kind: "text", index: 1, text: "\n" },
      ]).map((e) => e.kind),
    ).toEqual(["assistant-thinking"]);
  });

  test("the finished row hides the text block whose text it holds", () => {
    const blocks: PartialBlock[] = [
      { kind: "text", index: 0, text: "Hello, wor" },
    ];
    expect(drawn(blocks, [text("m1", "Hello, world.")])).toEqual([]);
    // Another message's row hides nothing.
    expect(drawn(blocks, [text("m0", "Hello, world.")])).toHaveLength(1);
  });

  test("thinking lands by count, a tool call by its id", () => {
    const blocks: PartialBlock[] = [
      { kind: "thinking", index: 0, text: "a" },
      { kind: "text", index: 1, text: "Now" },
      { kind: "thinking", index: 2, text: "b" },
    ];
    expect(drawn(blocks, [thinking("m1")]).map((e) => e.kind)).toEqual([
      "assistant-text",
      "assistant-thinking",
    ]);
    const tool: PartialBlock[] = [
      {
        kind: "tool_use",
        index: 0,
        toolUseId: "t1",
        name: "Write",
        inputJson: "{}",
      },
      {
        kind: "tool_use",
        index: 1,
        toolUseId: "t2",
        name: "Write",
        inputJson: "{",
      },
    ];
    expect(
      drawn(tool, [call("m1", "t1")]).map(
        (e) => e.kind === "tool-call" && e.toolUseId,
      ),
    ).toEqual(["t2"]);
  });

  test("a block is landed once a later one is, so a stand-in never sits below a row after it", () => {
    expect(
      drawn(
        [
          { kind: "thinking", index: 0, text: "a" },
          {
            kind: "tool_use",
            index: 1,
            toolUseId: "t1",
            name: "Write",
            inputJson: "{}",
          },
          { kind: "text", index: 2, text: "More" },
        ],
        [call("m1", "t1")],
      ).map((e) => e.kind),
    ).toEqual(["assistant-text"]);
  });

  test("text, a tool call, then more text: only the landed block goes", () => {
    expect(
      drawn(
        [
          { kind: "text", index: 2, text: "Now the second" },
          { kind: "text", index: 0, text: "First part." },
        ],
        [text("m1", "First part.")],
      ),
    ).toEqual([
      {
        kind: "assistant-text",
        at: AT,
        messageId: "m1",
        text: "Now the second",
      },
    ]);
  });

  test("a block that did not change keeps its stand-in event; one that grew gets a new one", () => {
    const think: PartialBlock = { kind: "thinking", index: 0, text: "hmm" };
    const tool: PartialBlock = {
      kind: "tool_use",
      index: 1,
      toolUseId: "toolu_1",
      name: "Write",
      inputJson: '{"file_path":"/a',
    };
    const [t1, c1] = drawn([think, tool]);
    const grown: PartialBlock = { ...tool, inputJson: tool.inputJson + "b" };
    const [t2, c2] = drawn([think, grown]);
    expect(t2).toBe(t1);
    expect(c2).not.toBe(c1);
    expect(c2).toMatchObject({ input: { file_path: "/ab" } });
  });
});
