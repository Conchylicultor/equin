/**
 * Triage order: priority must → should → could → wont → untriaged, then the
 * oldest filed, then the task id.
 *
 * Run: `./equin test plugins/tasks/plugins/task-triage`.
 */

import { expect, test } from "bun:test";
import { compareByTriage, type TriageRankable } from "./rank";

const day = (d: number) => new Date(Date.UTC(2026, 9, d));

function ids(rows: TriageRankable[]): string[] {
  return [...rows].sort(compareByTriage).map((r) => r.taskId);
}

test("priority first, untriaged last", () => {
  expect(
    ids([
      { taskId: "none", createdAt: day(1), priority: null },
      { taskId: "wont", createdAt: day(1), priority: "wont" },
      { taskId: "could", createdAt: day(1), priority: "could" },
      { taskId: "must", createdAt: day(5), priority: "must" },
      { taskId: "should", createdAt: day(1), priority: "should" },
    ]),
  ).toEqual(["must", "should", "could", "wont", "none"]);
});

test("within a priority, the oldest filed first", () => {
  expect(
    ids([
      { taskId: "new", createdAt: day(9), priority: "should" },
      { taskId: "old", createdAt: day(2), priority: "should" },
      { taskId: "untriaged-new", createdAt: day(9), priority: null },
      { taskId: "untriaged-old", createdAt: day(1), priority: null },
    ]),
  ).toEqual(["old", "new", "untriaged-old", "untriaged-new"]);
});

test("a tie breaks on the task id, so the order is total", () => {
  expect(
    ids([
      { taskId: "b", createdAt: day(3), priority: "could" },
      { taskId: "a", createdAt: day(3), priority: "could" },
    ]),
  ).toEqual(["a", "b"]);
  expect(
    compareByTriage(
      { taskId: "a", createdAt: day(3), priority: "must" },
      { taskId: "a", createdAt: day(3), priority: "must" },
    ),
  ).toBe(0);
});
