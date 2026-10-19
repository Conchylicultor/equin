import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { findAwaitingAuqEvent } from "./awaiting";
import { ANSWER_MARKER } from "../../shared";

const AT = "2026-10-19T00:00:00.000Z";

const cancelledQuestion: JsonlEvent = {
  kind: "tool-call",
  at: AT,
  toolUseId: "toolu_q",
  name: "AskUserQuestion",
  input: { questions: [] },
  result: {
    at: AT,
    isError: true,
    content: "The user doesn't want to proceed with this tool use.",
  },
};
const userText = (text: string): JsonlEvent => ({
  kind: "user-text",
  at: AT,
  text,
});

describe("findAwaitingAuqEvent", () => {
  test("a cancelled question with nothing after it awaits its answer", () => {
    expect(
      findAwaitingAuqEvent([
        cancelledQuestion,
        userText("[Request interrupted by user for tool use]"),
      ]),
    ).toBe(cancelledQuestion);
  });

  test("an answer turn ends the wait", () => {
    expect(
      findAwaitingAuqEvent([
        cancelledQuestion,
        userText(`${ANSWER_MARKER}\n- Which? → A`),
      ]),
    ).toBeNull();
  });

  test("a message sent in place of the answer ends the wait", () => {
    expect(
      findAwaitingAuqEvent([
        cancelledQuestion,
        userText("[Request interrupted by user for tool use]"),
        userText("Never mind, do something else."),
      ]),
    ).toBeNull();
  });
});
