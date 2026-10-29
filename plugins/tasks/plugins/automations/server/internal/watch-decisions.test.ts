import { describe, expect, test } from "bun:test";
import { filingSettled } from "./refire-watch";
import { slotDecision } from "./slot-watch";

const TASK = "task-1";
const ev = (kind: string, taskId = TASK) => ({ kind, taskId });

describe("slotDecision", () => {
  test("the task's own report releases the slot", () => {
    expect(slotDecision([ev("reported")], TASK)).toBe("release");
    expect(slotDecision([ev("asking")], TASK)).toBe("release");
  });

  test("a report wins over a settle in the same batch", () => {
    expect(slotDecision([ev("settled"), ev("reported")], TASK)).toBe("release");
  });

  test("settled, stopped and held wake without releasing", () => {
    for (const kind of ["settled", "stopped", "held"])
      expect(slotDecision([ev(kind)], TASK)).toBe("wake");
  });

  test("a deeper task's events are not the launch's", () => {
    expect(
      slotDecision([ev("reported", "task-2"), ev("settled", "task-2")], TASK),
    ).toBe("none");
  });

  test("other facts change nothing", () => {
    expect(
      slotDecision([ev("started"), ev("created"), ev("quiet")], TASK),
    ).toBe("none");
  });
});

describe("filingSettled", () => {
  test("only the filed task's own settle counts", () => {
    expect(filingSettled([ev("settled")], TASK)).toBe(true);
    expect(filingSettled([ev("settled", "task-2")], TASK)).toBe(false);
    expect(filingSettled([ev("stopped"), ev("held")], TASK)).toBe(false);
  });
});
