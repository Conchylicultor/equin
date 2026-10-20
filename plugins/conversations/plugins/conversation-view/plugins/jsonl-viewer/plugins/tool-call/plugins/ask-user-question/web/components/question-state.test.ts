import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { questionState, type QuestionHolderView } from "./question-state";
import { ANSWER_MARKER } from "../../shared";

const AT = "2026-10-19T00:00:00.000Z";

type ToolCall = Extract<JsonlEvent, { kind: "tool-call" }>;

const askedQuestion: ToolCall = {
  kind: "tool-call",
  at: AT,
  toolUseId: "toolu_q",
  name: "AskUserQuestion",
  input: { questions: [] },
};
const cancelledQuestion: ToolCall = {
  ...askedQuestion,
  result: {
    at: AT,
    isError: true,
    content: "The user doesn't want to proceed with this tool use.",
  },
};
// What the CLI fills in on resume when the session ended mid-question.
const restartedQuestion: ToolCall = {
  ...askedQuestion,
  result: {
    at: AT,
    isError: true,
    outcomeUnknown: true,
    content:
      "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]",
  },
};
const answeredQuestion: ToolCall = {
  ...askedQuestion,
  result: {
    at: AT,
    isError: false,
    content: "Your questions have been answered",
  },
};
const userText = (text: string): JsonlEvent => ({
  kind: "user-text",
  at: AT,
  text,
});
const laterToolCall: JsonlEvent = {
  kind: "tool-call",
  at: AT,
  toolUseId: "toolu_next",
  name: "Bash",
  input: {},
};

const idle: QuestionHolderView = { status: "waiting", waitingFor: null };
const holding: QuestionHolderView = {
  status: "waiting",
  waitingFor: "question",
};
const working: QuestionHolderView = { status: "working", waitingFor: null };
const gone: QuestionHolderView = { status: "gone", waitingFor: null };

const kindOf = (
  events: JsonlEvent[],
  call: ToolCall,
  conversation: QuestionHolderView | null,
) => questionState(events, call, conversation).kind;

describe("questionState", () => {
  test("an open call a live holder waits on is held", () => {
    expect(kindOf([askedQuestion], askedQuestion, holding)).toBe("held");
  });

  test("an open call while the agent is mid-turn is still being asked", () => {
    expect(kindOf([askedQuestion], askedQuestion, working)).toBe("asking");
  });

  test("an open call nothing holds is orphaned", () => {
    expect(kindOf([askedQuestion], askedQuestion, idle)).toBe("orphaned");
  });

  test("a terminal-cancelled call with nothing after it is orphaned", () => {
    expect(
      kindOf(
        [
          cancelledQuestion,
          userText("[Request interrupted by user for tool use]"),
        ],
        cancelledQuestion,
        idle,
      ),
    ).toBe("orphaned");
  });

  test("a call the session ended on (filled in on resume) is orphaned", () => {
    expect(kindOf([restartedQuestion], restartedQuestion, idle)).toBe(
      "orphaned",
    );
  });

  test("an answer turn after a restart-filled call settles it", () => {
    expect(
      kindOf(
        [restartedQuestion, userText(`${ANSWER_MARKER}\n- Which? → A`)],
        restartedQuestion,
        idle,
      ),
    ).toBe("settled");
  });

  test("an orphan in a conversation that can take no turn is settled", () => {
    expect(kindOf([askedQuestion], askedQuestion, gone)).toBe("settled");
  });

  test("without a conversation row nothing can be answered", () => {
    expect(kindOf([askedQuestion], askedQuestion, null)).toBe("settled");
  });

  test("an answer turn settles it", () => {
    expect(
      kindOf(
        [askedQuestion, userText(`${ANSWER_MARKER}\n- Which? → A`)],
        askedQuestion,
        idle,
      ),
    ).toBe("settled");
  });

  test("a message sent in place of the answer settles it", () => {
    expect(
      kindOf(
        [
          cancelledQuestion,
          userText("[Request interrupted by user for tool use]"),
          userText("Never mind, do something else."),
        ],
        cancelledQuestion,
        idle,
      ),
    ).toBe("settled");
  });

  test("a later tool call settles it", () => {
    expect(kindOf([askedQuestion, laterToolCall], askedQuestion, idle)).toBe(
      "settled",
    );
  });

  test("a real result settles it, even while a holder waits", () => {
    expect(kindOf([answeredQuestion], answeredQuestion, holding)).toBe(
      "settled",
    );
  });
});
