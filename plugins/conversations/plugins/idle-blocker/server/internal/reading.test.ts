import { describe, expect, test } from "bun:test";
import { agentsReading } from "./reading";

describe("agentsReading", () => {
  test("no working agent is quiet", () => {
    expect(agentsReading(0)).toEqual({
      busy: false,
      label: "no agent working",
      recheckAt: null,
    });
  });
  test("working agents are busy, counted", () => {
    expect(agentsReading(1)).toEqual({
      busy: true,
      label: "1 agent working",
      recheckAt: null,
    });
    expect(agentsReading(3).label).toBe("3 agents working");
  });
});
