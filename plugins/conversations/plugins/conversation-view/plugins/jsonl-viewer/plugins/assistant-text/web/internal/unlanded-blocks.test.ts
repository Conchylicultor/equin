import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { unlandedBlocks } from "./unlanded-blocks";

const text = (messageId: string, t: string): JsonlEvent => ({
  kind: "assistant-text",
  at: "2026-10-20T00:00:00Z",
  messageId,
  text: t,
});

describe("unlandedBlocks", () => {
  test("a message with no transcript row yet is drawn whole", () => {
    const blocks = [{ index: 0, text: "Hello, wor" }];
    expect(unlandedBlocks({ messageId: "m1", blocks }, [])).toEqual(blocks);
  });

  test("the finished row hides the block whose text it holds", () => {
    const m = { messageId: "m1", blocks: [{ index: 0, text: "Hello, wor" }] };
    expect(unlandedBlocks(m, [text("m1", "Hello, world.")])).toEqual([]);
  });

  test("another message's row hides nothing", () => {
    const m = { messageId: "m2", blocks: [{ index: 0, text: "Hello" }] };
    expect(unlandedBlocks(m, [text("m1", "Hello")])).toHaveLength(1);
  });

  test("text, a tool call, then more text: only the landed block goes", () => {
    const m = {
      messageId: "m1",
      blocks: [
        { index: 2, text: "Now the second" },
        { index: 0, text: "First part." },
      ],
    };
    expect(unlandedBlocks(m, [text("m1", "First part.")])).toEqual([
      { index: 2, text: "Now the second" },
    ]);
  });

  test("blocks are drawn in content order, blank ones not at all", () => {
    const m = {
      messageId: "m1",
      blocks: [
        { index: 3, text: "b" },
        { index: 1, text: "a" },
        { index: 2, text: "\n" },
      ],
    };
    expect(unlandedBlocks(m, []).map((b) => b.text)).toEqual(["a", "b"]);
  });
});
