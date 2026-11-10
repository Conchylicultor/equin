import { describe, expect, test } from "bun:test";
import { judgeDelivery } from "./verdict";

const sentAt = new Date("2026-11-09T12:36:23.900Z");
const send = {
  context: "<received-instructions>…</received-instructions>",
  sentAt,
};

const at = (offsetMs: number) =>
  new Date(sentAt.getTime() + offsetMs).toISOString();

function hookContext(content: string[], offsetMs = 100) {
  return {
    type: "attachment",
    timestamp: at(offsetMs),
    attachment: {
      type: "hook_additional_context",
      hookName: "SessionStart",
      hookEvent: "SessionStart",
      content,
    },
  };
}

describe("judgeDelivery", () => {
  test("pending until something decisive is written", () => {
    expect(judgeDelivery([], send)).toEqual({ kind: "pending" });
    expect(
      judgeDelivery([{ type: "system", timestamp: at(50) }], send),
    ).toEqual({ kind: "pending" });
  });

  test("the exact text among the SessionStart contexts is delivered", () => {
    expect(
      judgeDelivery([hookContext(["other hook", send.context])], send),
    ).toEqual({ kind: "delivered" });
  });

  test("the CLI's persisted-output preview is a cut", () => {
    const preview =
      "<persisted-output>\nOutput too large (34.3KB). Full output saved to: /x.txt\n\nPreview (first 2KB):\n…\n</persisted-output>";
    expect(judgeDelivery([hookContext([preview])], send)).toEqual({
      kind: "cut",
      received: "preview",
      receivedChars: preview.length,
    });
  });

  test("any other text is a cut (fails closed)", () => {
    expect(judgeDelivery([hookContext(["something else"])], send)).toEqual({
      kind: "cut",
      received: "altered",
      receivedChars: "something else".length,
    });
  });

  test("the agent answering with no SessionStart context is a cut", () => {
    expect(
      judgeDelivery([{ type: "assistant", timestamp: at(500) }], send),
    ).toEqual({ kind: "cut", received: "none", receivedChars: 0 });
  });

  test("lines from before the send are ignored", () => {
    expect(
      judgeDelivery(
        [
          hookContext(["an older compaction's context"], -60_000),
          { type: "assistant", timestamp: at(-30_000) },
        ],
        send,
      ),
    ).toEqual({ kind: "pending" });
  });
});
