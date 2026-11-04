import { describe, expect, test } from "bun:test";
import {
  readAgents,
  readManageAnswer,
  readMessageAnswer,
  readTaskTree,
} from "./parse";

describe("readManageAnswer", () => {
  test("an edit or a drop is done", () => {
    expect(readManageAnswer("Edited task-1 (start armed).")).toEqual({
      kind: "done",
    });
    expect(readManageAnswer("Dropped task-1.")).toEqual({ kind: "done" });
  });

  test("a refusal carries its message", () => {
    expect(
      readManageAnswer("Refused: task-1 is dropped — it will not run."),
    ).toEqual({
      kind: "refused",
      message: "task-1 is dropped — it will not run.",
    });
  });
});

describe("readMessageAnswer", () => {
  test("a sent message names its conversation and how it lands", () => {
    expect(
      readMessageAnswer(
        "Sent to conv-1: it is working, and reads the message at its next step.",
      ),
    ).toEqual({
      kind: "sent",
      conversationId: "conv-1",
      delivery: "It is working, and reads the message at its next step.",
    });
  });

  test("a refusal is not sent", () => {
    expect(readMessageAnswer("Not sent: it has closed.")).toEqual({
      kind: "not-sent",
      message: "it has closed.",
    });
  });

  test("an answer in another shape is kept as text", () => {
    expect(readMessageAnswer("something else")).toEqual({
      kind: "unread",
      text: "something else",
    });
  });
});

describe("readTaskTree", () => {
  const tree = [
    "Your task tree (root task-1):",
    '- task-1 "Audit \\"slow\\" ops" — in_progress, main',
    '  - task-2 "Child" — done, main, report: Problem, your task',
    '    - task-3 "Grandchild" — new, sidequest, manual',
    "  something unreadable",
  ].join("\n");

  test("reads the root, each line's depth, status and words", () => {
    const read = readTaskTree(tree);
    expect(read.rootTaskId).toBe("task-1");
    expect(read.lines).toEqual([
      {
        kind: "task",
        depth: 0,
        taskId: "task-1",
        title: 'Audit "slow" ops',
        status: "in_progress",
        words: ["main"],
        self: false,
      },
      {
        kind: "task",
        depth: 1,
        taskId: "task-2",
        title: "Child",
        status: "done",
        words: ["main", "report: Problem"],
        self: true,
      },
      {
        kind: "task",
        depth: 2,
        taskId: "task-3",
        title: "Grandchild",
        status: "new",
        words: ["sidequest", "manual"],
        self: false,
      },
      { kind: "text", text: "something unreadable" },
    ]);
  });

  test("an unknown status is kept as a word", () => {
    const [line] = readTaskTree('- task-1 "T" — someday, main').lines;
    expect(line).toMatchObject({ status: null, words: ["someday", "main"] });
  });

  test("an answer with no header is all lines", () => {
    expect(readTaskTree("This conversation has no task.")).toEqual({
      rootTaskId: null,
      lines: [{ kind: "text", text: "This conversation has no task." }],
    });
  });
});

describe("readAgents", () => {
  test("reads each agent, its standing and the caller's own", () => {
    const agents = readAgents(
      [
        '- task-1 "Diagnose "slow" builds" · conv-1 · idle',
        '- task-2 "Other" · conv-2 · working · status unverified · you',
        "",
        "2 tasks no agent ran on yet (see `task_tree`).",
      ].join("\n"),
    );
    expect(agents).toEqual([
      {
        kind: "agent",
        taskId: "task-1",
        title: 'Diagnose "slow" builds',
        conversationId: "conv-1",
        standing: "idle",
        self: false,
      },
      {
        kind: "agent",
        taskId: "task-2",
        title: "Other",
        conversationId: "conv-2",
        standing: "working · status unverified",
        self: true,
      },
      { kind: "text", text: "2 tasks no agent ran on yet (see `task_tree`)." },
    ]);
  });
});
