import { describe, expect, test } from "bun:test";
import { stepIndex, switcherOrder } from "./switcher-model";

describe("switcherOrder", () => {
  test("lists the desktop's windows front-most first", () => {
    const windows = [
      { id: "a", desktopId: "d1", geo: { z: 1 } },
      { id: "b", desktopId: "d1", geo: { z: 3 } },
      { id: "c", desktopId: "d2", geo: { z: 9 } },
      { id: "d", desktopId: "d1", geo: { z: 2 } },
    ];
    expect(switcherOrder(windows, "d1").map((w) => w.id)).toEqual([
      "b",
      "d",
      "a",
    ]);
  });
});

describe("stepIndex", () => {
  test("the opening press steps from the front-most window", () => {
    expect(stepIndex(0, 1, 4)).toBe(1);
    expect(stepIndex(0, -1, 4)).toBe(3);
  });

  test("wraps at both ends", () => {
    expect(stepIndex(3, 1, 4)).toBe(0);
    expect(stepIndex(0, -1, 2)).toBe(1);
    expect(stepIndex(1, 1, 2)).toBe(0);
  });
});
