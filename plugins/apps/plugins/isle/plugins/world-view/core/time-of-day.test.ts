import { describe, expect, test } from "bun:test";
import { dayPhaseAt } from "./time-of-day";

const at = (h: number, m = 0, day = 14) => new Date(2026, 10, day, h, m, 0, 0);

describe("dayPhaseAt", () => {
  test.each([
    [3, 0, "night"],
    [5, 29, "night"],
    [5, 30, "dusk"],
    [7, 29, "dusk"],
    [7, 30, "day"],
    [16, 59, "day"],
    [17, 0, "dusk"],
    [19, 59, "dusk"],
    [20, 0, "night"],
    [23, 59, "night"],
  ] as const)("%d:%d is %s", (h, m, phase) => {
    expect(dayPhaseAt(at(h, m)).phase).toBe(phase);
  });

  test("the next boundary is the next phase's start, same day", () => {
    expect(dayPhaseAt(at(12)).next).toEqual(at(17));
    expect(dayPhaseAt(at(6)).next).toEqual(at(7, 30));
    expect(dayPhaseAt(at(17)).next).toEqual(at(20));
  });

  test("after the last boundary, the next is tomorrow's dawn", () => {
    expect(dayPhaseAt(at(21)).next).toEqual(at(5, 30, 15));
    expect(dayPhaseAt(at(2)).next).toEqual(at(5, 30));
  });

  test("at the boundary next phase reads as begun, its own next later", () => {
    const p = dayPhaseAt(at(7, 30));
    expect(p.phase).toBe("day");
    expect(p.next).toEqual(at(17));
  });
});
