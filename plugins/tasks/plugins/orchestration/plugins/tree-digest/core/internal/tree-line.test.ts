import { describe, expect, test } from "bun:test";
import {
  formatTreeHeader,
  formatTreeLine,
  readTree,
  type TreeLine,
} from "./tree-line";

const lines: TreeLine[] = [
  {
    depth: 0,
    taskId: "task-1",
    title: 'Audit "slow" ops',
    words: ["in_progress", "main"],
    self: false,
  },
  {
    depth: 1,
    taskId: "task-2",
    title: "Child, with a comma",
    words: ["done", "main", "report: Problem"],
    self: true,
  },
  {
    depth: 2,
    taskId: "task-3",
    title: "Grandchild — dash",
    words: ["new", "sidequest", "manual"],
    self: false,
  },
];

describe("tree lines", () => {
  test("a written tree reads back as written", () => {
    const text = [
      formatTreeHeader("task-1"),
      ...lines.map(formatTreeLine),
    ].join("\n");
    expect(readTree(text)).toEqual({
      rootTaskId: "task-1",
      lines: lines.map((l) => ({ kind: "task", ...l })),
    });
  });

  test("the caller's own task is marked at the end of its words", () => {
    expect(formatTreeLine(lines[1]!)).toBe(
      '  - task-2 "Child, with a comma" — done, main, report: Problem, your task',
    );
  });

  test("a line in another shape is kept as text", () => {
    expect(
      readTree("Changed in your task tree since you last saw it:\n+3 more"),
    ).toEqual({
      rootTaskId: null,
      lines: [
        {
          kind: "text",
          text: "Changed in your task tree since you last saw it:",
        },
        { kind: "text", text: "+3 more" },
      ],
    });
  });
});
