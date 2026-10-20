import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { SubagentEntry } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import type { WorkflowRunEntry } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core";
import type { BackgroundShell } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/core";
import {
  DONE_LINGER_MS,
  agentRow,
  allAgentRows,
  nextLingerExpiry,
  rowsUnder,
  summarizeAgents,
  visibleAgentRows,
  workflowRow,
} from "./agent-rows";

const T0 = Date.parse("2026-09-22T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000);

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/** The band's rows from sub-agents alone, or with the runs some sit under. */
const visible = (
  entries: SubagentEntry[],
  now: number,
  workflowRuns: WorkflowRunEntry[] = [],
  shells: BackgroundShell[] = [],
) => visibleAgentRows({ entries, workflowRuns, shells }, now);

function call(input: Record<string, unknown>): ToolCallEvent {
  return {
    kind: "tool-call",
    at: at(0).toISOString(),
    toolUseId: "toolu_1",
    name: "Agent",
    input: { prompt: "do it", ...input },
  };
}

function entry(over: Partial<SubagentEntry> & { id: string }): SubagentEntry {
  const { id, ...rest } = over;
  return {
    row: {
      kind: "described",
      agentId: id,
      agentType: "Explore",
      description: "Search auth flow",
      toolUseId: "toolu_1",
      startedAt: at(0).toISOString(),
      lastActivityAt: at(30).toISOString(),
      turnEnded: false,
      newestTurnLineAt: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      lastStep: { kind: "tool", toolName: "Read", preview: "auth.ts" },
    },
    state: { kind: "running" },
    startedAt: at(0),
    endedAt: null,
    lastStep: { kind: "tool", toolName: "Read", preview: "auth.ts" },
    agentToolEvent: undefined,
    ...rest,
  };
}

describe("agentRow", () => {
  test("reads the meta file first, and the parent's call for what it never recorded", () => {
    const row = agentRow(
      entry({
        id: "a",
        row: {
          kind: "described",
          agentId: "a",
          agentType: "Plan",
          description: "Design migration path",
          toolUseId: "toolu_1",
          // No `model` and no `requestShape` — the older half of the corpus.
          startedAt: at(0).toISOString(),
          lastActivityAt: at(30).toISOString(),
          turnEnded: false,
          newestTurnLineAt: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          lastStep: null,
        },
        agentToolEvent: call({ model: "opus", run_in_background: true }),
      }),
    );

    expect(row).toMatchObject({
      key: "a",
      type: "Plan",
      description: "Design migration path",
      model: "opus",
      background: true,
      parentKey: null,
    });
  });

  test("a recorded requestShape wins over the call's flag", () => {
    const row = agentRow(
      entry({
        id: "a",
        row: {
          kind: "described",
          agentId: "a",
          agentType: "Explore",
          description: "d",
          requestShape: "foreground",
          startedAt: at(0).toISOString(),
          lastActivityAt: at(1).toISOString(),
          turnEnded: false,
          newestTurnLineAt: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          lastStep: null,
        },
        agentToolEvent: call({ run_in_background: true }),
      }),
    );
    expect(row.background).toBe(false);
  });

  test("a stringly-typed run_in_background (the harness accepts it) reads as the boolean it spells", () => {
    const launch = (value: string) =>
      agentRow(
        entry({
          id: "s",
          row: {
            kind: "undescribed",
            agentId: "s",
            reason: "missing",
            startedAt: at(0).toISOString(),
            lastActivityAt: at(1).toISOString(),
            turnEnded: false,
            newestTurnLineAt: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            lastStep: null,
          },
          agentToolEvent: call({ run_in_background: value }),
        }),
      );
    expect(launch("true").background).toBe(true);
    expect(launch("false").background).toBe(false);
    expect(() => launch("yes")).toThrow();
  });

  test("an unreadable meta still yields a row, described by the parent's call", () => {
    const row = agentRow(
      entry({
        id: "broken",
        row: {
          kind: "undescribed",
          agentId: "broken",
          reason: "not valid JSON",
          startedAt: at(0).toISOString(),
          lastActivityAt: at(5).toISOString(),
          turnEnded: false,
          newestTurnLineAt: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          lastStep: { kind: "tool-result" },
        },
        lastStep: { kind: "tool-result" },
        agentToolEvent: call({ description: "Audit endpoints" }),
      }),
    );
    expect(row).toMatchObject({
      key: "broken",
      type: "general-purpose",
      description: "Audit endpoints",
      model: null,
    });
  });

  test("a teammate another sub-agent spawned sits under that sub-agent", () => {
    // No tool-use id, and its launching call is not in the conversation's
    // transcript — but its own id and its parent's are both on disk.
    const row = agentRow(
      entry({
        id: "mate",
        row: {
          kind: "described",
          agentId: "mate",
          agentType: "fork",
          description: "Verify boundaries",
          name: "live-probe",
          parentAgentId: "lead",
          startedAt: at(0).toISOString(),
          lastActivityAt: at(1).toISOString(),
          turnEnded: false,
          newestTurnLineAt: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          lastStep: null,
        },
      }),
    );
    expect(row).toMatchObject({ key: "mate", parentKey: "lead" });
  });
});

describe("visibleAgentRows", () => {
  const running = entry({ id: "running" });
  const background = entry({
    id: "background",
    row: {
      kind: "described",
      agentId: "background",
      agentType: "Explore",
      description: "Find theme tokens",
      toolUseId: "toolu_bg",
      requestShape: "background",
      startedAt: at(0).toISOString(),
      lastActivityAt: at(10).toISOString(),
      turnEnded: false,
      newestTurnLineAt: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      lastStep: null,
    },
  });
  const justFinished = entry({
    id: "finished",
    state: { kind: "finished" },
    endedAt: at(58),
  });
  const longFinished = entry({
    id: "old",
    state: { kind: "finished" },
    endedAt: at(10),
  });
  const justEnded = entry({
    id: "ended",
    state: { kind: "ended-without-reporting" },
    endedAt: at(59),
  });

  const now = at(60).getTime();

  test("shows what is running, plus what stopped within the linger", () => {
    const rows = visible(
      [running, background, justFinished, longFinished, justEnded],
      now,
    );
    expect(rows.map((r) => r.key)).toEqual([
      "running",
      "background",
      "finished",
      "ended",
    ]);
    expect(rows[1]).toMatchObject({ kind: "agent", background: true });
  });

  test("a sub-agent that ended without reporting leaves like any other", () => {
    const later = at(59).getTime() + DONE_LINGER_MS;
    expect(visible([justEnded], later).map((r) => r.key)).toEqual([]);
  });

  test("the next expiry is the first row due to leave", () => {
    const rows = visible([running, justFinished, justEnded], now);
    expect(nextLingerExpiry(rows, now)).toBe(at(58).getTime() + DONE_LINGER_MS);
    expect(nextLingerExpiry(visible([running], now), now)).toBeNull();
  });

  const child = (id: string, parent: string, over?: Partial<SubagentEntry>) =>
    entry({
      id,
      row: {
        kind: "described",
        agentId: id,
        agentType: "batch",
        description: `Verify ${id}`,
        name: id,
        parentAgentId: parent,
        startedAt: at(0).toISOString(),
        lastActivityAt: at(30).toISOString(),
        turnEnded: false,
        newestTurnLineAt: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        lastStep: null,
      },
      ...over,
    });

  test("a finished parent stays while something under it is still shown", () => {
    // `old` finished long ago; its child, and that child's own child, are
    // still going. Dropping `old` would move `mid` to the top level — a claim
    // that the conversation launched it.
    const rows = visible(
      [longFinished, child("mid", "old"), child("leaf", "mid")],
      now,
    );
    expect(rows.map((r) => [r.key, r.parentKey])).toEqual([
      ["old", null],
      ["mid", "old"],
      ["leaf", "mid"],
    ]);
  });

  test("the parent leaves with its last child", () => {
    const gone = child("mid", "old", {
      state: { kind: "finished" },
      endedAt: at(10),
    });
    expect(visible([longFinished, gone], now)).toEqual([]);
  });

  test("a parent kept only for its children arms no timer of its own", () => {
    // Its linger ran out before `now`; waiting on it would fire at once, forever.
    const rows = visible([longFinished, child("mid", "old")], now);
    expect(nextLingerExpiry(rows, now)).toBeNull();
  });

  test("a parent that is not on disk leaves its child at the top level", () => {
    const rows = visible([child("orphan", "missing")], now);
    expect(rows.map((r) => r.key)).toEqual(["orphan"]);
  });
});

describe("visibleAgentRows with showAll", () => {
  test("keeps every agent, finished long ago or not, but not a stopped shell", () => {
    const now = at(3000).getTime();
    const rows = visibleAgentRows(
      {
        entries: [
          entry({ id: "old", state: { kind: "finished" }, endedAt: at(10) }),
        ],
        workflowRuns: [],
        shells: [],
      },
      now,
      { showAll: true },
    );
    expect(rows.map((row) => row.key)).toEqual(["old"]);
    expect(
      visible(
        [entry({ id: "old", state: { kind: "finished" }, endedAt: at(10) })],
        now,
      ),
    ).toEqual([]);
  });
});

describe("summarizeAgents", () => {
  test("counts only what is still working, and clocks the longest of those", () => {
    const now = at(300).getTime();
    const rows = visible(
      [
        entry({ id: "a", startedAt: at(60) }),
        entry({ id: "b", startedAt: at(120) }),
        entry({ id: "done", state: { kind: "finished" }, endedAt: at(299) }),
      ],
      now,
    );
    expect(summarizeAgents(rows)).toEqual({
      running: 2,
      agents: 3,
      shellsRunning: 0,
      runsGoing: 0,
      longestSince: at(60),
    });
  });

  test("nothing running is nothing working, however many rows linger", () => {
    const now = at(300).getTime();
    const rows = visible(
      [entry({ id: "done", state: { kind: "finished" }, endedAt: at(299) })],
      now,
    );
    expect(summarizeAgents(rows)).toEqual({
      running: 0,
      agents: 1,
      shellsRunning: 0,
      runsGoing: 0,
      longestSince: null,
    });
  });
});

describe("workflow runs", () => {
  const now = at(60).getTime();

  const workflowCall = (script: unknown): ToolCallEvent => ({
    kind: "tool-call",
    at: at(1).toISOString(),
    toolUseId: "toolu_wf",
    name: "Workflow",
    input: { script },
  });

  const run = (over: Partial<WorkflowRunEntry> = {}): WorkflowRunEntry => ({
    runId: "wf_abc",
    call: workflowCall(
      "export const meta = { name: 'Audit plugins', phases: [] };\n",
    ),
    state: { kind: "running" },
    startedAt: at(1),
    endedAt: null,
    ...over,
  });

  const workflowAgent = (
    id: string,
    over: Partial<SubagentEntry> & { reported?: boolean } = {},
  ) => {
    const { reported = false, ...rest } = over;
    return entry({
      id,
      row: {
        kind: "described",
        agentId: id,
        agentType: "workflow-subagent",
        description: `Review ${id}`,
        workflowPhase: "Review",
        requestShape: "foreground",
        startedAt: at(2).toISOString(),
        lastActivityAt: at(30).toISOString(),
        turnEnded: false,
        newestTurnLineAt: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        lastStep: null,
        workflow: { runId: "wf_abc", reported },
      },
      startedAt: at(2),
      ...rest,
    });
  };

  test("a run is a top-level row named by its script, and its agents sit under it", () => {
    const rows = visible([workflowAgent("w1"), workflowAgent("w2")], now, [
      run(),
    ]);
    expect(
      rows.map((r) => [r.kind, r.key, r.parentKey, r.type, r.description]),
    ).toEqual([
      ["workflow", "workflow:wf_abc", null, "workflow", "Audit plugins"],
      ["agent", "w1", "workflow:wf_abc", "Review", "Review w1"],
      ["agent", "w2", "workflow:wf_abc", "Review", "Review w2"],
    ]);
  });

  test("a run whose script names nothing goes by its run id", () => {
    expect(workflowRow(run({ call: undefined })).description).toBe("wf_abc");
    expect(
      workflowRow(run({ call: workflowCall(undefined) })).description,
    ).toBe("wf_abc");
    expect(
      workflowRow(run({ call: workflowCall("await agent('x');\n") }))
        .description,
    ).toBe("wf_abc");
  });

  test("a run interleaves with the conversation's own sub-agents by start", () => {
    const early = entry({ id: "early", startedAt: at(0) });
    const late = entry({ id: "late", startedAt: at(5) });
    const rows = visible([early, workflowAgent("w1"), late], now, [run()]);
    expect(rows.map((r) => r.key)).toEqual([
      "early",
      "workflow:wf_abc",
      "w1",
      "late",
    ]);
  });

  test("an ended run stays while an agent under it lingers, and arms only that agent's timer", () => {
    const rows = visible(
      [
        workflowAgent("w1", {
          state: { kind: "finished" },
          endedAt: at(58),
          reported: true,
        }),
      ],
      now,
      [run({ state: { kind: "finished" }, endedAt: at(10) })],
    );
    expect(rows.map((r) => r.key)).toEqual(["workflow:wf_abc", "w1"]);
    expect(nextLingerExpiry(rows, now)).toBe(at(58).getTime() + DONE_LINGER_MS);
  });

  test("an ended run leaves with its last agent", () => {
    const rows = visible(
      [workflowAgent("w1", { state: { kind: "finished" }, endedAt: at(10) })],
      now,
      [run({ state: { kind: "finished" }, endedAt: at(10) })],
    );
    expect(rows).toEqual([]);
  });

  test("a running run between phases shows on its own", () => {
    const rows = visible(
      [workflowAgent("w1", { state: { kind: "finished" }, endedAt: at(10) })],
      now,
      [run()],
    );
    expect(rows.map((r) => r.key)).toEqual(["workflow:wf_abc"]);
  });

  test("the summary counts agents, never the run", () => {
    const rows = visible([workflowAgent("w1"), workflowAgent("w2")], now, [
      run({ startedAt: at(1) }),
    ]);
    expect(summarizeAgents(rows)).toEqual({
      running: 2,
      agents: 2,
      shellsRunning: 0,
      runsGoing: 1,
      longestSince: at(2),
    });
    // A run alone, between phases, is not "1 agent working" — but it is going.
    expect(summarizeAgents(visible([], now, [run()]))).toEqual({
      running: 0,
      agents: 0,
      shellsRunning: 0,
      runsGoing: 1,
      longestSince: null,
    });
  });
});

describe("background shells", () => {
  const now = at(60).getTime();

  const shell = (
    id: string,
    over: Partial<BackgroundShell> = {},
  ): BackgroundShell => ({
    shellId: id,
    toolUseId: `toolu_${id}`,
    command: `npm run ${id}`,
    description: undefined,
    outputFile: `/private/tmp/claude-501/x/y/tasks/${id}.output`,
    startedAt: at(0),
    endedAt: null,
    state: { kind: "running" },
    ...over,
  });

  test("a shell is a top-level row named by its description, else its command", () => {
    const rows = visible(
      [],
      now,
      [],
      [shell("b1", { description: "Build the app" }), shell("b2")],
    );
    expect(
      rows.map((r) => [r.kind, r.key, r.parentKey, r.type, r.description]),
    ).toEqual([
      ["shell", "shell:b1", null, "shell", "Build the app"],
      ["shell", "shell:b2", null, "shell", "npm run b2"],
    ]);
  });

  test("shells interleave with sub-agents by start", () => {
    const rows = visible(
      [
        entry({ id: "early", startedAt: at(0) }),
        entry({ id: "late", startedAt: at(10) }),
      ],
      now,
      [],
      [shell("mid", { startedAt: at(5) })],
    );
    expect(rows.map((r) => r.key)).toEqual(["early", "shell:mid", "late"]);
  });

  test("a finished shell lingers from its notification, then leaves", () => {
    const done = shell("d", {
      state: { kind: "completed", exitCode: 0 },
      endedAt: at(59),
    });
    expect(visible([], now, [], [done]).map((r) => r.key)).toEqual(["shell:d"]);
    expect(nextLingerExpiry(visible([], now, [], [done]), now)).toBe(
      at(59).getTime() + DONE_LINGER_MS,
    );
    const later = at(59).getTime() + DONE_LINGER_MS;
    expect(visible([], later, [], [done])).toEqual([]);
  });

  test("a shell that ended without reporting has no end to linger from, so it is not shown", () => {
    const rows = visible(
      [],
      now,
      [],
      [shell("gone", { state: { kind: "ended-without-reporting" } })],
    );
    expect(rows).toEqual([]);
    expect(nextLingerExpiry(rows, now)).toBeNull();
  });

  test("the summary counts shells apart, and clocks the longest of agents and shells", () => {
    const rows = visible(
      [entry({ id: "a", startedAt: at(20) })],
      now,
      [],
      [
        shell("s1", { startedAt: at(5) }),
        shell("s2", { startedAt: at(30) }),
        shell("s3", { state: { kind: "killed" }, endedAt: at(59) }),
      ],
    );
    expect(summarizeAgents(rows)).toEqual({
      running: 1,
      agents: 1,
      shellsRunning: 2,
      runsGoing: 0,
      longestSince: at(5),
    });
  });
});

describe("allAgentRows / rowsUnder", () => {
  const child = (id: string, parent: string | undefined) =>
    entry({
      id,
      row: {
        kind: "described",
        agentId: id,
        agentType: "fork",
        description: id,
        ...(parent === undefined ? {} : { parentAgentId: parent }),
        startedAt: at(0).toISOString(),
        lastActivityAt: at(1).toISOString(),
        turnEnded: true,
        newestTurnLineAt: null,
        usage: { input: 0, output: 7, cacheRead: 0, cacheCreation: 0 },
        lastStep: null,
      },
      state: { kind: "finished" },
    });
  const entries = [
    child("lead", undefined),
    child("mate", "lead"),
    child("grandchild", "mate"),
    child("other", undefined),
  ];

  test("lists every agent, finished or not, with its own token total", () => {
    const rows = allAgentRows({ entries, workflowRuns: [] });
    expect(rows.map((row) => row.key)).toEqual([
      "lead",
      "mate",
      "grandchild",
      "other",
    ]);
    expect(rows[0]).toMatchObject({ usage: { output: 7 } });
  });

  test("keeps only what descends from a root, at any depth", () => {
    const rows = allAgentRows({ entries, workflowRuns: [] });
    expect(rowsUnder(rows, "lead").map((row) => row.key)).toEqual([
      "mate",
      "grandchild",
    ]);
    expect(rowsUnder(rows, null)).toHaveLength(4);
  });
});
