import { describe, expect, test } from "bun:test";
import {
  blockingSidequests,
  renderOpenSidequests,
  type SidequestCandidate,
} from "./open-sidequests";

// The exit gate's decision: a waiting sidequest blocks only while the caller's
// task owns it as its filer.

const mine: SidequestCandidate = {
  id: "task-a",
  title: "Flaky retry",
  owner: { kind: "filer", taskId: "task-me" },
};

describe("blockingSidequests", () => {
  test("only those the caller's task owns as their filer", () => {
    const candidates: SidequestCandidate[] = [
      mine,
      // Handed to a role: filed by me, the role's now.
      {
        id: "task-b",
        title: "Handed off",
        owner: { kind: "claimed", label: "role", owns: async () => false },
      },
      // Filed by another task's agent (a relaunch of a sibling).
      {
        id: "task-c",
        title: "Not mine",
        owner: { kind: "filer", taskId: "task-other" },
      },
      // In a supervisor's tree.
      {
        id: "task-d",
        title: "Supervised",
        owner: { kind: "supervisor", rootTaskId: "task-sup" },
      },
      // Gone since the read.
      { id: "task-e", title: "Deleted", owner: null },
    ];
    expect(blockingSidequests(candidates, "task-me")).toEqual([mine]);
    expect(blockingSidequests(candidates, "task-nobody")).toEqual([]);
  });
});

describe("renderOpenSidequests", () => {
  test("lists each one and says how to resolve it", () => {
    const text = renderOpenSidequests([mine], false);
    expect(text).toContain("- task-a — Flaky retry");
    expect(text).toContain("drop_task");
    expect(text).toContain('supervisor: "<role id>"');
    expect(text).not.toContain("and more");
    expect(renderOpenSidequests([mine], true)).toContain("…and more");
  });
});
