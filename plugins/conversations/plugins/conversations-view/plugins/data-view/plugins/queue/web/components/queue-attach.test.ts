import { describe, expect, test } from "bun:test";
import { taskManagerShape } from "@plugins/tasks/plugins/orchestration/plugins/watch/core";
import { stepFlags, supervisingTaskIds } from "./queue-attach";

/** A live row of `taskId`, managed by `manager` (null: the person's own). */
const row = (taskId: string, status: string, manager: string | null) => ({
  taskId,
  status,
  $columns: {
    [taskManagerShape.exposure.slice]: {
      managerTaskId: manager,
      managedBy: manager === null ? "you" : "agent",
    },
  },
});

describe("supervisingTaskIds", () => {
  test("every manager up the chain of a running task, and no other", () => {
    const ids = supervisingTaskIds([
      row("root", "waiting", null),
      row("sub", "waiting", "root"),
      row("leaf", "working", "sub"),
      row("idle-sup", "waiting", null),
      row("idle-child", "waiting", "idle-sup"),
      row("other", "starting", null),
    ]);
    expect([...ids].sort()).toEqual(["root", "sub"]);
  });

  test("a finished or gone child supervises nothing", () => {
    expect(
      supervisingTaskIds([
        row("sup", "waiting", null),
        row("child", "gone", "sup"),
      ]).size,
    ).toBe(0);
  });
});

describe("stepFlags", () => {
  test("a group drawn beneath its supervisor is skipped by its neighbours' steps", () => {
    // a, b (attached beneath a), c
    const flags = stepFlags(["a", "b", "c"], (g) => g !== "b");
    expect(flags.get("a")).toEqual({
      isTop: true,
      isBottom: false,
      canStepDown: true,
    });
    expect(flags.get("b")).toEqual({
      isTop: false,
      isBottom: false,
      canStepDown: false,
    });
    expect(flags.get("c")).toEqual({
      isTop: false,
      isBottom: true,
      canStepDown: false,
    });
  });

  test("the last top-level group is the bottom even when an attached one follows it", () => {
    const flags = stepFlags(["a", "b"], (g) => g === "a");
    expect(flags.get("a")).toEqual({
      isTop: true,
      isBottom: true,
      canStepDown: false,
    });
  });
});
