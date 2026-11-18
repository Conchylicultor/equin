import { describe, expect, test } from "bun:test";
import { checkoutStepStats, percentiles, segmentStats } from "./stats";
import type { LaunchSample } from "./stats";

const T0 = Date.UTC(2026, 10, 18, 12);

function launch(
  marks: LaunchSample["marks"],
  steps: LaunchSample["checkoutSteps"] = [],
): LaunchSample {
  return {
    requestedAt: new Date(T0),
    marks,
    checkoutSteps: steps,
    checkoutSource: null,
  };
}

describe("percentiles", () => {
  test("nearest rank", () => {
    expect(percentiles([5, 1, 4, 2, 3, 6, 7, 8, 9, 10])).toEqual({
      n: 10,
      p50: 5,
      p90: 9,
    });
    expect(percentiles([7])).toEqual({ n: 1, p50: 7, p90: 7 });
  });
  test("no value is no percentile, not zero", () => {
    expect(percentiles([])).toEqual({ n: 0, p50: null, p90: null });
  });
});

describe("segmentStats", () => {
  test("a stretch counts only launches that reached both ends", () => {
    const stats = segmentStats([
      launch({ "spawn-started": T0 + 100, "agent-started": T0 + 9000 }),
      launch({ "spawn-started": T0 + 300 }),
    ]);
    const byId = new Map(stats.map((s) => [s.id, s]));
    expect(byId.get("queue")).toMatchObject({ n: 2, p50: 100, p90: 300 });
    expect(byId.get("to-agent")).toMatchObject({ n: 1, p50: 9000 });
    expect(byId.get("cli-init")).toMatchObject({ n: 0, p50: null });
  });
  test("a reordered phase reads as a negative stretch, the totals still hold", () => {
    // The agent started before the checkout ended (started while installing).
    const [handOff] = segmentStats([
      launch({ "prepare-ended": T0 + 5000, "agent-started": T0 + 3000 }),
    ]).filter((s) => s.id === "hand-off");
    expect(handOff!.p50).toBe(-2000);
  });
});

describe("checkoutStepStats", () => {
  test("a step run twice in one checkout counts its sum", () => {
    const stats = checkoutStepStats([
      launch({}, [
        { step: "gate-wait", ms: 10, endAt: T0 },
        { step: "install", ms: 900, endAt: T0 },
        { step: "gate-wait", ms: 30, endAt: T0 },
      ]),
      launch({}, [{ step: "install", ms: 1100, endAt: T0 }]),
    ]);
    expect(stats).toEqual([
      { step: "gate-wait", n: 1, p50: 40, p90: 40 },
      { step: "install", n: 2, p50: 900, p90: 1100 },
    ]);
  });
});
