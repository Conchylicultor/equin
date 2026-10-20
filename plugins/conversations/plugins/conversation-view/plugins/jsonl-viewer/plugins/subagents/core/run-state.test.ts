import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { subagentRunState } from "./run-state";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type TaskNotificationEvent = Extract<JsonlEvent, { kind: "task-notification" }>;

const TOOL_USE_ID = "toolu_1";

const agentCall = (withResult: boolean): ToolCallEvent => ({
  kind: "tool-call",
  at: "2026-09-20T10:00:00.000Z",
  toolUseId: TOOL_USE_ID,
  name: "Agent",
  input: {},
  ...(withResult
    ? { result: { at: "2026-09-20T10:05:00.000Z", content: "done" } }
    : {}),
});

const notification = (
  toolUseId: string | undefined,
): TaskNotificationEvent => ({
  kind: "task-notification",
  at: "2026-09-20T10:05:00.000Z",
  taskId: "task-1",
  toolUseId,
  status: "completed",
  summary: "Report delivered.",
});

describe("subagentRunState", () => {
  test("foreground: the parent's tool_result lands only at completion, so it means finished", () => {
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: agentCall(true),
        taskNotifications: [],
        requestShape: "foreground",
        turnEnded: false,
        conversationStatus: "working",
      }),
    ).toEqual({ kind: "finished" });
  });

  test("background: the same tool_result is only a launch acknowledgement, so it means nothing", () => {
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: agentCall(true),
        taskNotifications: [],
        requestShape: "background",
        turnEnded: false,
        conversationStatus: "working",
      }),
    ).toEqual({ kind: "running" });
  });

  test("background: the task-notification carrying the same tool-use id is what finishes it", () => {
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: agentCall(true),
        taskNotifications: [
          notification("toolu_other"),
          notification(TOOL_USE_ID),
        ],
        requestShape: "background",
        turnEnded: false,
        conversationStatus: "working",
      }),
    ).toEqual({ kind: "finished" });
  });

  test("a notification for another sub-agent does not finish this one", () => {
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: agentCall(false),
        taskNotifications: [
          notification("toolu_other"),
          notification(undefined),
        ],
        requestShape: "background",
        turnEnded: false,
        conversationStatus: "working",
      }),
    ).toEqual({ kind: "running" });
  });

  test("no completion and the parent still has a live process: running", () => {
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: agentCall(false),
        taskNotifications: [],
        requestShape: "background",
        turnEnded: false,
        conversationStatus: "waiting",
      }),
    ).toEqual({ kind: "running" });
  });

  test("no completion and the parent is gone: ended without reporting, never 'still running'", () => {
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: agentCall(false),
        taskNotifications: [],
        requestShape: "background",
        turnEnded: false,
        conversationStatus: "done",
      }),
    ).toEqual({ kind: "ended-without-reporting" });
  });

  test("meta not landed yet: neither signal can be trusted, so the parent's liveness decides", () => {
    // A foreground-looking result under an unknown shape must NOT be read as
    // completion — that is exactly the case where it might be a launch ack.
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: agentCall(true),
        taskNotifications: [],
        requestShape: undefined,
        turnEnded: false,
        conversationStatus: "working",
      }),
    ).toEqual({ kind: "running" });
    expect(
      subagentRunState({
        toolUseId: TOOL_USE_ID,
        agentToolEvent: undefined,
        taskNotifications: [],
        requestShape: undefined,
        turnEnded: false,
        conversationStatus: "done",
      }),
    ).toEqual({ kind: "ended-without-reporting" });
  });

  test("nested teammate: no launching call or notification in the conversation, but its own turn ended — finished", () => {
    // conv-1790156090-2opp: six teammates started by a sub-agent, whose own
    // transcripts closed with `end_turn`, read "running" for over an hour
    // because nothing in the conversation's transcript could ever finish them.
    expect(
      subagentRunState({
        toolUseId: "",
        agentToolEvent: undefined,
        taskNotifications: [],
        requestShape: "background",
        turnEnded: true,
        conversationStatus: "working",
      }),
    ).toEqual({ kind: "finished" });
  });

  test("no end marker seen is not evidence either way: liveness still decides", () => {
    expect(
      subagentRunState({
        toolUseId: "",
        agentToolEvent: undefined,
        taskNotifications: [],
        requestShape: "background",
        turnEnded: false,
        conversationStatus: "working",
      }),
    ).toEqual({ kind: "running" });
    expect(
      subagentRunState({
        toolUseId: "",
        agentToolEvent: undefined,
        taskNotifications: [],
        requestShape: "background",
        turnEnded: undefined,
        conversationStatus: "done",
      }),
    ).toEqual({ kind: "ended-without-reporting" });
  });

  describe("a workflow agent", () => {
    // Real shape: `{agentType:"workflow-subagent", workflowPhase, spawnDepth:1,
    // requestShape:"foreground"}` — foreground, yet no `toolUseId` and no
    // `Agent` call to carry a result. Only its run's journal can finish it.
    const workflowAgent = {
      toolUseId: "",
      agentToolEvent: undefined,
      taskNotifications: [],
      requestShape: "foreground" as const,
    };

    test("its journal `result` line means finished, even while the parent works", () => {
      expect(
        subagentRunState({
          ...workflowAgent,
          turnEnded: false,
          conversationStatus: "working",
          workflowReported: true,
          workflowRunEnded: false,
        }),
      ).toEqual({ kind: "finished" });
    });

    test("its run ended and it never reported: ended without reporting, though the parent lives on", () => {
      expect(
        subagentRunState({
          ...workflowAgent,
          turnEnded: false,
          conversationStatus: "working",
          workflowReported: false,
          workflowRunEnded: true,
        }),
      ).toEqual({ kind: "ended-without-reporting" });
    });

    test("its own turn end still wins over its run having ended", () => {
      expect(
        subagentRunState({
          ...workflowAgent,
          turnEnded: true,
          conversationStatus: "working",
          workflowReported: false,
          workflowRunEnded: true,
        }),
      ).toEqual({ kind: "finished" });
    });

    test("a live run and no report yet: the parent's liveness decides", () => {
      expect(
        subagentRunState({
          ...workflowAgent,
          turnEnded: false,
          conversationStatus: "working",
          workflowReported: false,
          workflowRunEnded: false,
        }),
      ).toEqual({ kind: "running" });
    });
  });
  describe("a named teammate", () => {
    // conv-1790861753-uid9's automations-web: no tool-use id, so no
    // notification can match; its last text piece has stop_reason null.
    const teammate = {
      toolUseId: "",
      agentToolEvent: undefined,
      taskNotifications: [],
      requestShape: "background" as const,
      turnEnded: false,
      conversationStatus: "working" as const,
    };

    test("its idle notification, with nothing written since, finishes it", () => {
      expect(
        subagentRunState({
          ...teammate,
          teammateIdle: {
            idleAt: "2026-10-07T02:34:00.465Z",
            newestTurnLineAt: "2026-10-07T02:34:00.164Z",
          },
        }),
      ).toEqual({ kind: "finished" });
    });

    test("a line written after the idle notification means it was woken: running again", () => {
      expect(
        subagentRunState({
          ...teammate,
          teammateIdle: {
            idleAt: "2026-10-07T02:33:34.804Z",
            newestTurnLineAt: "2026-10-07T02:33:39.334Z",
          },
        }),
      ).toEqual({ kind: "running" });
    });

    test("woken and its lead gone: ended without reporting, not finished", () => {
      expect(
        subagentRunState({
          ...teammate,
          conversationStatus: "done",
          teammateIdle: {
            idleAt: "2026-10-07T02:33:34.804Z",
            newestTurnLineAt: "2026-10-07T02:33:39.334Z",
          },
        }),
      ).toEqual({ kind: "ended-without-reporting" });
    });
  });

  describe("a background sub-agent resumed with SendMessage", () => {
    // conv-1791379404-0sgk: notified at 13:36 for its first run, resumed at
    // 13:44 and 13:57 — each later notification carries the resuming
    // SendMessage's tool-use id, and the first one used to finish it for good.
    const AGENT_ID = "a1e0d7d9ad5e40dcd";
    const notified = (
      at: string,
      toolUseId: string,
    ): TaskNotificationEvent => ({
      kind: "task-notification",
      at,
      taskId: AGENT_ID,
      toolUseId,
      status: "completed",
      summary: "Agent finished",
    });
    const base = {
      toolUseId: TOOL_USE_ID,
      agentId: AGENT_ID,
      agentToolEvent: agentCall(true),
      requestShape: "background" as const,
      turnEnded: false,
      conversationStatus: "waiting" as const,
    };

    test("a notification older than the newest resume ended an earlier turn: running", () => {
      expect(
        subagentRunState({
          ...base,
          taskNotifications: [
            notified("2026-10-07T13:36:41.413Z", TOOL_USE_ID),
            notified("2026-10-07T13:48:10.518Z", "toolu_send_1"),
          ],
          resumedAt: "2026-10-07T13:57:10.551Z",
        }),
      ).toEqual({ kind: "running" });
    });

    test("the resumed turn's own notification, carrying the SendMessage's id, finishes it again", () => {
      expect(
        subagentRunState({
          ...base,
          taskNotifications: [
            notified("2026-10-07T13:36:41.413Z", TOOL_USE_ID),
            notified("2026-10-07T14:02:27.459Z", "toolu_send_2"),
          ],
          resumedAt: "2026-10-07T13:57:10.551Z",
        }),
      ).toEqual({ kind: "finished" });
    });

    test("a resumed foreground agent's tool_result is stale too", () => {
      expect(
        subagentRunState({
          ...base,
          requestShape: "foreground",
          taskNotifications: [],
          resumedAt: "2026-09-20T10:06:00.000Z",
        }),
      ).toEqual({ kind: "running" });
    });
  });
});
