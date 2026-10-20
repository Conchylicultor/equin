import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { subagentReport } from "./report";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/** Verbatim shape of the launch receipt the harness writes for a background Agent call. */
const RECEIPT =
  "Async agent launched successfully. This is internal metadata; do not surface it. agentId: a1b2c3";

const agentCall = (content: string | undefined): ToolCallEvent => ({
  kind: "tool-call",
  at: "2026-09-20T10:00:00.000Z",
  toolUseId: "toolu_1",
  name: "Agent",
  input: {},
  ...(content === undefined
    ? {}
    : { result: { at: "2026-09-20T10:05:00.000Z", content } }),
});

const handback = (message: unknown): JsonlEvent => ({
  kind: "tool-call",
  at: "2026-09-20T10:04:00.000Z",
  toolUseId: "toolu_hb",
  name: "SubagentHandback",
  input: { message },
});

const text = (t: string): JsonlEvent => ({
  kind: "assistant-text",
  at: "2026-09-20T10:03:00.000Z",
  text: t,
});

describe("subagentReport", () => {
  test("foreground: the parent's tool_result IS the return value, so it is the report", () => {
    expect(
      subagentReport({
        requestShape: "foreground",
        agentToolEvent: agentCall("Here is what I found."),
        events: [],
      }),
    ).toEqual({
      kind: "report",
      text: "Here is what I found.",
      isError: false,
    });
  });

  test("foreground: an error result is still the report", () => {
    const event = agentCall("it blew up");
    event.result!.isError = true;
    expect(
      subagentReport({
        requestShape: "foreground",
        agentToolEvent: event,
        events: [],
      }),
    ).toEqual({ kind: "report", text: "it blew up", isError: true });
  });

  test("background: the launch receipt is NEVER the report", () => {
    // The bug this pins: the receipt is not the report, the harness marks it as
    // internal metadata never to be surfaced, and printing it buries the work.
    const result = subagentReport({
      requestShape: "background",
      agentToolEvent: agentCall(RECEIPT),
      events: [text("thinking"), handback("The write-up.")],
    });
    expect(result).toEqual({
      kind: "report",
      text: "The write-up.",
      isError: false,
    });
  });

  test("background: the LAST handback is what the caller was left holding", () => {
    expect(
      subagentReport({
        requestShape: "background",
        agentToolEvent: agentCall(RECEIPT),
        events: [
          handback("first pass"),
          text("more work"),
          handback("final answer"),
        ],
      }),
    ).toEqual({ kind: "report", text: "final answer", isError: false });
  });

  test("background with no handback: none, rather than the receipt", () => {
    // Every background sub-agent from before the harness wrote handbacks
    // (2026-09-15). Its transcript is already on screen; there is no report.
    expect(
      subagentReport({
        requestShape: "background",
        agentToolEvent: agentCall(RECEIPT),
        events: [text("worked, said nothing back")],
      }),
    ).toEqual({ kind: "none" });
  });

  test("an unrecorded shape claims nothing, because the result could be either", () => {
    expect(
      subagentReport({
        requestShape: undefined,
        agentToolEvent: agentCall(RECEIPT),
        events: [handback("a write-up")],
      }),
    ).toEqual({ kind: "none" });
  });

  test("foreground with no result yet: none, never an empty report card", () => {
    expect(
      subagentReport({
        requestShape: "foreground",
        agentToolEvent: agentCall(undefined),
        events: [],
      }),
    ).toEqual({ kind: "none" });
  });
});
