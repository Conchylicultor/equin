import { describe, expect, test } from "bun:test";
import { stoppedEvents } from "./watch-sources";

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
