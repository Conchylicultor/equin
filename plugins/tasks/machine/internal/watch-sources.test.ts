import { describe, expect, test } from "bun:test";
import { settledEvents, stoppedEvents } from "./watch-sources";

describe("stoppedEvents", () => {
  test("entering attempted is `stopped`", () => {
    const [e] = stoppedEvents({
      taskId: "task-1",
      status: "attempted",
      previousStatus: "in_progress",
    });
    expect(e?.kind).toBe("stopped");
    expect(e?.taskId).toBe("task-1");
  });

  test("entering held is `held`", () => {
    expect(
      stoppedEvents({
        taskId: "task-1",
        status: "held",
        previousStatus: "need_action",
      }).map((e) => e.kind),
    ).toEqual(["held"]);
  });

  test("no event without a transition, or into any other status", () => {
    expect(
      stoppedEvents({ taskId: "t", status: "held", previousStatus: "held" }),
    ).toEqual([]);
    for (const status of ["done", "dropped", "new", "in_progress"] as const)
      expect(
        stoppedEvents({ taskId: "t", status, previousStatus: "attempted" }),
      ).toEqual([]);
  });
});

describe("settledEvents", () => {
  test("fires when a task settles", () => {
    expect(
      settledEvents({
        taskId: "t",
        status: "done",
        previousStatus: "in_progress",
      }),
    ).toEqual([
      { kind: "settled", taskId: "t", summary: "in_progress → done" },
    ]);
  });

  // A dropped task whose work then landed: the watcher must hear `done`.
  test("fires again when a dropped task turns out done", () => {
    expect(
      settledEvents({ taskId: "t", status: "done", previousStatus: "dropped" }),
    ).toEqual([{ kind: "settled", taskId: "t", summary: "dropped → done" }]);
  });

  test("is silent off a settled status, or with no change", () => {
    expect(
      settledEvents({
        taskId: "t",
        status: "attempted",
        previousStatus: "done",
      }),
    ).toEqual([]);
    expect(
      settledEvents({ taskId: "t", status: "done", previousStatus: "done" }),
    ).toEqual([]);
  });
});
