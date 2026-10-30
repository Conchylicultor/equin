import { describe, expect, test } from "bun:test";
import { buildJsonlEvents } from "./parse-jsonl";

// The session ended (a restart) while a tool call was in flight; on resume the
// CLI fills the call's result in, then appends a synthetic reply to it.

const AT = "2026-10-20T22:05:23.526Z";
const PLACEHOLDER =
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]";

const noImages = () => {
  throw new Error("no image expected");
};

const toolUse = {
  type: "assistant",
  uuid: "a1",
  parentUuid: null,
  timestamp: AT,
  message: {
    role: "assistant",
    id: "msg_1",
    content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
  },
};
const resultLine = (extra: Record<string, unknown>, content: string) => ({
  type: "user",
  uuid: "u1",
  parentUuid: "a1",
  timestamp: AT,
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content },
    ],
  },
  ...extra,
});
const syntheticReply = {
  type: "assistant",
  uuid: "a2",
  parentUuid: "u1",
  timestamp: AT,
  message: {
    role: "assistant",
    id: "msg_2",
    model: "<synthetic>",
    content: [{ type: "text", text: "No response requested." }],
  },
};

describe("buildJsonlEvents — a call the session ended on", () => {
  test("its filled-in result is an error of unknown outcome, the synthetic reply dropped", async () => {
    const events = await buildJsonlEvents(
      [
        toolUse,
        resultLine({ toolDenialKind: "interrupted" }, PLACEHOLDER),
        syntheticReply,
      ],
      noImages,
    );
    expect(events).toHaveLength(1);
    const call = events[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.result?.isError).toBe(true);
    expect(call.result?.outcomeUnknown).toBe(true);
  });

  test("a genuine error keeps its known outcome and the reply after it", async () => {
    const events = await buildJsonlEvents(
      [toolUse, resultLine({}, "Exit code 1"), syntheticReply],
      noImages,
    );
    const call = events[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.result?.isError).toBe(true);
    expect(call.result?.outcomeUnknown).toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(["tool-call", "assistant-text"]);
  });
});

// The line each sdk turn becomes carries the turn's uuid (the SDK user
// message's), which the web's echo retires on — a slash command too, and a turn
// a busy agent absorbed mid-turn as a `queued_command` attachment's
// `source_uuid`. Shapes read from real transcripts (2026-10-25).
describe("buildJsonlEvents — a turn's line carries its uuid", () => {
  test("a slash command's line is a user row with the turn's uuid", async () => {
    const events = await buildJsonlEvents(
      [
        {
          type: "user",
          uuid: "turn-uuid",
          parentUuid: null,
          timestamp: AT,
          message: {
            role: "user",
            content:
              "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
          },
        },
      ],
      noImages,
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "user-text", uuid: "turn-uuid" }),
    ]);
  });

  test("a turn folded into a running turn is the user's message under its source_uuid", async () => {
    const events = await buildJsonlEvents(
      [
        {
          type: "attachment",
          uuid: "att-line",
          parentUuid: null,
          timestamp: AT,
          attachment: {
            type: "queued_command",
            prompt: "i.e. do not file the task",
            source_uuid: "turn-uuid",
            commandMode: "prompt",
          },
        },
      ],
      noImages,
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "user-text",
        text: "i.e. do not file the task",
        uuid: "turn-uuid",
      }),
    ]);
  });
});

// An `event` turn the app delivered to a watching agent is typed inside the
// turn ledger's envelope (turn-ledger core/event-envelope.ts).
describe("buildJsonlEvents — an event turn", () => {
  const ENVELOPE = "<equin-event>\nreported · task-1\n\ndigest\n</equin-event>";

  test("is an event-turn under its line's uuid, not the user's message", async () => {
    const events = await buildJsonlEvents(
      [
        {
          type: "user",
          uuid: "turn-uuid",
          parentUuid: null,
          timestamp: AT,
          message: { role: "user", content: ENVELOPE },
        },
      ],
      noImages,
    );
    expect(events).toEqual([
      {
        kind: "event-turn",
        at: AT,
        text: "reported · task-1\n\ndigest",
        uuid: "turn-uuid",
      },
    ]);
  });

  test("in a text block too", async () => {
    const events = await buildJsonlEvents(
      [
        {
          type: "user",
          uuid: "turn-uuid",
          parentUuid: null,
          timestamp: AT,
          message: {
            role: "user",
            content: [{ type: "text", text: ENVELOPE }],
          },
        },
      ],
      noImages,
    );
    expect(events.map((e) => e.kind)).toEqual(["event-turn"]);
  });

  test("sends merged into one line carry every send's uuid", async () => {
    // CLI 2.1.310 dequeued two event turns sent 2 ms apart as ONE line: its
    // uuid is the first send's, the second's only in `mergedSendUuids`.
    const events = await buildJsonlEvents(
      [
        {
          type: "user",
          uuid: "first-send",
          parentUuid: null,
          timestamp: AT,
          mergedSendUuids: ["second-send"],
          message: { role: "user", content: `${ENVELOPE}\n${ENVELOPE}` },
        },
      ],
      noImages,
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "event-turn",
        uuid: "first-send",
        mergedSendUuids: ["second-send"],
      }),
    ]);
  });

  test("folded into a running turn, under its source_uuid", async () => {
    const events = await buildJsonlEvents(
      [
        {
          type: "attachment",
          uuid: "att-line",
          parentUuid: null,
          timestamp: AT,
          attachment: {
            type: "queued_command",
            prompt: ENVELOPE,
            source_uuid: "turn-uuid",
            commandMode: "prompt",
          },
        },
      ],
      noImages,
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "event-turn", uuid: "turn-uuid" }),
    ]);
  });

  test("a message that only mentions the tag stays the user's", async () => {
    const events = await buildJsonlEvents(
      [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: AT,
          message: {
            role: "user",
            content: "what is <equin-event>x</equin-event>?",
          },
        },
      ],
      noImages,
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "user-text", uuid: "u1" }),
    ]);
  });
});

// The launch preprompt is appended to the system prompt; the CLI records the
// system prompt in a `prompt_snapshot` attachment written after the first turn.
describe("buildJsonlEvents — the launch preprompt", () => {
  const prompt = (uuid: string, content: string, at = AT) => ({
    type: "user",
    uuid,
    parentUuid: null,
    timestamp: at,
    message: { role: "user", content },
  });
  const snapshot = (uuid: string, last: string) => ({
    type: "attachment",
    uuid,
    parentUuid: "u1",
    timestamp: "2026-10-20T22:05:24.000Z",
    attachment: {
      type: "prompt_snapshot",
      systemPrompt: ["You are Claude Code.", last],
    },
  });
  const BLOCK = "<special_instructions>\nBe terse.\n</special_instructions>";

  test("a system-prompt preprompt heads the conversation, before its first prompt", async () => {
    const events = await buildJsonlEvents(
      [prompt("u1", "hi"), snapshot("s1", BLOCK), snapshot("s2", BLOCK)],
      noImages,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "preprompt",
      "user-text",
      "attachment",
      "attachment",
    ]);
    expect(events[0]).toEqual({ kind: "preprompt", at: AT, text: "Be terse." });
  });

  test("a system prompt that does not end in the block carries none", async () => {
    const events = await buildJsonlEvents(
      [prompt("u1", "hi"), snapshot("s1", "Some other section.")],
      noImages,
    );
    expect(events.some((e) => e.kind === "preprompt")).toBe(false);
  });

  test("a preprompt baked into the first turn (older launches) is lifted once", async () => {
    const events = await buildJsonlEvents(
      [prompt("u1", `${BLOCK}\n\nhi`), snapshot("s1", BLOCK)],
      noImages,
    );
    expect(events.filter((e) => e.kind === "preprompt")).toHaveLength(1);
    expect(events[1]).toMatchObject({ kind: "user-text", text: "hi" });
  });
});

// Hook records carry the toolUseID of the call they ran on.
const hookLine = (uuid: string, attachment: Record<string, unknown>) => ({
  type: "attachment",
  uuid,
  parentUuid: "a1",
  timestamp: AT,
  attachment,
});
const preHook = {
  hookName: "PreToolUse:Bash",
  hookEvent: "PreToolUse",
  toolUseID: "toolu_1",
};

describe("buildJsonlEvents — hooks ride on the call they ran on", () => {
  test("a pre-hook before the result and a block after it both land on the call", async () => {
    const events = await buildJsonlEvents(
      [
        toolUse,
        hookLine("h1", {
          type: "hook_success",
          ...preHook,
          exitCode: 0,
          command: "guard",
          durationMs: 12,
        }),
        resultLine({}, "PreToolUse:Bash hook error: BLOCKED"),
        hookLine("h2", {
          type: "hook_stopped_continuation",
          ...preHook,
          message: "BLOCKED",
        }),
      ],
      noImages,
    );
    expect(events.map((e) => e.kind)).toEqual(["tool-call"]);
    const call = events[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.hooks?.map((h) => [h.event, h.outcome, h.text])).toEqual([
      ["PreToolUse", "pass", undefined],
      ["PreToolUse", "block", "BLOCKED"],
    ]);
    expect(call.hooks?.[0]?.durationMs).toBe(12);
  });

  test("a block only the result reports still lands on the call, once", async () => {
    const block = resultLine({}, "PreToolUse:Bash hook error: BLOCKED\n");
    const alone = await buildJsonlEvents([toolUse, block], noImages);
    const call = alone[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.hooks).toEqual([
      {
        at: AT,
        event: "PreToolUse",
        name: "PreToolUse:Bash",
        outcome: "block",
        text: "BLOCKED",
      },
    ]);
  });

  test("a result that is not a hook's refusal adds no hook", async () => {
    const events = await buildJsonlEvents(
      [toolUse, resultLine({}, "Exit code 1")],
      noImages,
    );
    const call = events[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.hooks).toBeUndefined();
  });

  test.each([
    ["hook_success", { exitCode: 2 }, "error"],
    ["hook_success", { exitCode: 0, stderr: "warn" }, "error"],
    ["hook_additional_context", { content: ["a", "b"] }, "context"],
    ["hook_system_message", { content: "tip" }, "message"],
    ["hook_non_blocking_error", { stderr: "x" }, "error"],
    ["hook_blocking_error", {}, "block"],
    ["hook_cancelled", {}, "cancelled"],
  ] as const)("%s %p is a %s", async (type, extra, outcome) => {
    const events = await buildJsonlEvents(
      [toolUse, hookLine("h1", { type, ...preHook, ...extra })],
      noImages,
    );
    const call = events[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.hooks?.[0]?.outcome).toBe(outcome);
  });

  test("added context is joined into the record's text", async () => {
    const events = await buildJsonlEvents(
      [
        toolUse,
        hookLine("h1", {
          type: "hook_additional_context",
          ...preHook,
          content: ["a", "b"],
        }),
      ],
      noImages,
    );
    const call = events[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.hooks?.[0]?.text).toBe("a\n\nb");
  });

  test("a hook naming no call, an unknown call, or an unknown subtype stays an attachment", async () => {
    const events = await buildJsonlEvents(
      [
        toolUse,
        hookLine("h1", {
          type: "hook_success",
          hookName: "SessionStart:startup",
          hookEvent: "SessionStart",
          exitCode: 0,
        }),
        hookLine("h2", { type: "hook_success", ...preHook, toolUseID: "nope" }),
        hookLine("h3", { type: "hook_brand_new", ...preHook }),
      ],
      noImages,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "tool-call",
      "attachment",
      "attachment",
      "attachment",
    ]);
    const call = events[0];
    if (call?.kind !== "tool-call") throw new Error("expected a tool call");
    expect(call.hooks).toBeUndefined();
  });
});
