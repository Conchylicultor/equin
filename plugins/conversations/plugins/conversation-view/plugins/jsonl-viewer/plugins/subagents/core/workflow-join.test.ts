import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { SubagentActivityRow } from "./protocol";
import {
  workflowCallsIn,
  workflowRunIdOf,
  workflowRunsOf,
} from "./workflow-join";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type TaskNotificationEvent = Extract<JsonlEvent, { kind: "task-notification" }>;

/** The receipt a real `Workflow` call returns, trimmed. */
const receipt = (runId: string) =>
  `Workflow launched in background.\nTask ID: wqdogd8d9\nRun ID: ${runId}\nSummary: Census the resources`;

const workflowCall = (
  toolUseId: string,
  result?: { content: string; isError?: boolean },
): ToolCallEvent => ({
  kind: "tool-call",
  at: "2026-09-27T01:18:00.000Z",
  toolUseId,
  name: "Workflow",
  input: { script: "export const meta = { name: 'census' }" },
  ...(result ? { result: { at: "2026-09-27T01:18:01.000Z", ...result } } : {}),
});

const notification = (toolUseId: string): TaskNotificationEvent => ({
  kind: "task-notification",
  at: "2026-09-27T01:48:00.000Z",
  taskId: "wqdogd8d9",
  toolUseId,
  status: "completed",
  summary: "Dynamic workflow completed",
});

const agent = (
  agentId: string,
  runId: string,
  over: Partial<{
    reported: boolean;
    turnEnded: boolean;
    startedAt: string;
    lastActivityAt: string;
  }> = {},
): SubagentActivityRow => ({
  kind: "described",
  agentId,
  agentType: "workflow-subagent",
  description: `census:${agentId}`,
  workflowPhase: "Census",
  spawnDepth: 1,
  requestShape: "foreground",
  startedAt: over.startedAt ?? "2026-09-27T01:19:00.000Z",
  lastActivityAt: over.lastActivityAt ?? "2026-09-27T01:30:00.000Z",
  lastStep: null,
  turnEnded: over.turnEnded ?? false,
  newestTurnLineAt: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  workflow: { runId, reported: over.reported ?? false },
});

const ordinary: SubagentActivityRow = {
  kind: "described",
  agentId: "plain",
  agentType: "Explore",
  description: "not in any run",
  toolUseId: "toolu_agent",
  startedAt: "2026-09-27T01:00:00.000Z",
  lastActivityAt: "2026-09-27T01:01:00.000Z",
  lastStep: null,
  turnEnded: false,
  newestTurnLineAt: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
};

describe("workflowRunIdOf", () => {
  test("reads the run id off the call's launch receipt", () => {
    expect(
      workflowRunIdOf(
        workflowCall("toolu_w", { content: receipt("wf_578295d7-e4a") }),
      ),
    ).toBe("wf_578295d7-e4a");
  });

  test("no result yet, an error result, or no run id in the folder shape: no run", () => {
    expect(workflowRunIdOf(workflowCall("toolu_w"))).toBeUndefined();
    expect(
      workflowRunIdOf(
        workflowCall("toolu_w", {
          content: receipt("wf_x"),
          isError: true,
        }),
      ),
    ).toBeUndefined();
    expect(
      workflowRunIdOf(workflowCall("toolu_w", { content: receipt("oops") })),
    ).toBeUndefined();
  });

  test("workflowCallsIn keeps only Workflow calls", () => {
    const events: JsonlEvent[] = [
      workflowCall("toolu_w"),
      { ...workflowCall("toolu_a"), name: "Agent" },
    ];
    expect(workflowCallsIn(events).map((c) => c.toolUseId)).toEqual([
      "toolu_w",
    ]);
  });
});

describe("workflowRunsOf", () => {
  const call = workflowCall("toolu_w", { content: receipt("wf_a") });

  test("only rows in a run make a run, and the run joins its call", () => {
    const runs = workflowRunsOf({
      rows: [ordinary, agent("a1", "wf_a"), agent("a2", "wf_a")],
      workflowCalls: [call],
      taskNotifications: [],
      conversationStatus: "working",
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "wf_a",
      call,
      state: { kind: "running" },
      endedAt: null,
    });
    expect(runs[0]!.startedAt.toISOString()).toBe(call.at);
  });

  test("the run's notification finishes it, whatever its agents say", () => {
    const [run] = workflowRunsOf({
      rows: [agent("a1", "wf_a")],
      workflowCalls: [call],
      taskNotifications: [notification("toolu_w")],
      conversationStatus: "working",
    });
    expect(run!.state).toEqual({ kind: "finished" });
    expect(run!.endedAt?.toISOString()).toBe("2026-09-27T01:48:00.000Z");
  });

  test("a run between phases, with every agent done, is still running while it has no notification", () => {
    const [run] = workflowRunsOf({
      rows: [agent("a1", "wf_a", { reported: true })],
      workflowCalls: [call],
      taskNotifications: [],
      conversationStatus: "working",
    });
    expect(run!.state).toEqual({ kind: "running" });
  });

  test("a call with no notification and a parent with no process: ended without reporting", () => {
    const [run] = workflowRunsOf({
      rows: [agent("a1", "wf_a")],
      workflowCalls: [call],
      taskNotifications: [],
      conversationStatus: "done",
    });
    expect(run!.state).toEqual({ kind: "ended-without-reporting" });
    expect(run!.endedAt?.toISOString()).toBe("2026-09-27T01:30:00.000Z");
  });

  describe("with no call to read", () => {
    test("it runs exactly while one of its agents does", () => {
      const [run] = workflowRunsOf({
        rows: [agent("a1", "wf_a", { reported: true }), agent("a2", "wf_a")],
        workflowCalls: [],
        taskNotifications: [],
        conversationStatus: "working",
      });
      expect(run!.call).toBeUndefined();
      expect(run!.state).toEqual({ kind: "running" });
      // Earliest agent start stands in for the missing call's time.
      expect(run!.startedAt.toISOString()).toBe("2026-09-27T01:19:00.000Z");
    });

    test("every agent reported: finished", () => {
      const [run] = workflowRunsOf({
        rows: [
          agent("a1", "wf_a", { reported: true }),
          agent("a2", "wf_a", {
            turnEnded: true,
            lastActivityAt: "2026-09-27T01:40:00.000Z",
          }),
        ],
        workflowCalls: [],
        taskNotifications: [],
        conversationStatus: "done",
      });
      expect(run!.state).toEqual({ kind: "finished" });
      expect(run!.endedAt?.toISOString()).toBe("2026-09-27T01:40:00.000Z");
    });

    test("an agent cut off with the parent: the run ended without reporting", () => {
      const [run] = workflowRunsOf({
        rows: [agent("a1", "wf_a", { reported: true }), agent("a2", "wf_a")],
        workflowCalls: [],
        taskNotifications: [],
        conversationStatus: "done",
      });
      expect(run!.state).toEqual({ kind: "ended-without-reporting" });
    });
  });

  test("runs come back in start order", () => {
    const runs = workflowRunsOf({
      rows: [
        agent("b1", "wf_b", { startedAt: "2026-09-27T02:42:00.000Z" }),
        agent("a1", "wf_a"),
      ],
      workflowCalls: [],
      taskNotifications: [],
      conversationStatus: "working",
    });
    expect(runs.map((r) => r.runId)).toEqual(["wf_a", "wf_b"]);
  });
});
