import { describe, expect, test } from "bun:test";
import { createAdmissionGate } from "./admission";

const limits = {
  windowMs: 60_000,
  perVisitorBatches: 3,
  globalBatches: 10,
  maxTrackedVisitors: 4,
};

describe("admission gate", () => {
  test("a visitor gets its batches, then waits for the window", () => {
    const gate = createAdmissionGate(limits);
    for (let i = 0; i < 3; i++)
      expect(gate.admit("a", 1_000).admitted).toBe(true);
    const refused = gate.admit("a", 31_000);
    expect(refused).toEqual({
      admitted: false,
      reason: "visitor-budget",
      retryAfterS: 30,
    });
    // Another visitor is not held by a's budget.
    expect(gate.admit("b", 31_000).admitted).toBe(true);
    // The window rolls: a's budget is back.
    expect(gate.admit("a", 61_000).admitted).toBe(true);
  });

  test("every visitor together is held to the global budget", () => {
    const gate = createAdmissionGate({ ...limits, maxTrackedVisitors: 100 });
    let admitted = 0;
    for (let v = 0; v < 50; v++)
      if (gate.admit(`v${v}`, 0).admitted) admitted++;
    expect(admitted).toBe(10);
    expect(gate.admit("late", 0)).toMatchObject({ reason: "global-budget" });
  });

  test("the tracked visitors never exceed the roster, and reset each window", () => {
    const gate = createAdmissionGate({ ...limits, globalBatches: 1_000 });
    for (let v = 0; v < 4; v++)
      expect(gate.admit(`v${v}`, 0).admitted).toBe(true);
    expect(gate.admit("v4", 0)).toMatchObject({ reason: "visitor-roster" });
    // A tracked visitor still spends its own budget.
    expect(gate.admit("v0", 0).admitted).toBe(true);
    expect(gate.trackedVisitors()).toBe(4);
    expect(gate.admit("v4", 60_000).admitted).toBe(true);
    expect(gate.trackedVisitors()).toBe(1);
  });
});
