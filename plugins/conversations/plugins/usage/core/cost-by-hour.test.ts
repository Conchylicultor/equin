import { describe, expect, test } from "bun:test";
import { costAtInstant, hourStartOf } from "./cost-by-hour";

describe("hourStartOf", () => {
  test("every instant of an hour spells one key", () => {
    const h = "2026-11-17T10:00:00.000Z";
    expect(hourStartOf(Date.parse(h))).toBe(h);
    expect(hourStartOf(Date.parse("2026-11-17T10:59:59.999Z"))).toBe(h);
    expect(hourStartOf(Date.parse("2026-11-17T10:12:34.567+02:00"))).toBe(
      "2026-11-17T08:00:00.000Z",
    );
  });
});

describe("costAtInstant", () => {
  const value = {
    before: { costUsd: 10, unpricedModels: ["old"] },
    steps: [
      { t: 100, costUsd: 11 },
      { t: 200, costUsd: 15 },
    ],
    unpricedFrom: [{ model: "new", t: 150 }],
  };

  test("the last step at or before the instant, else the cost before the hour", () => {
    expect(costAtInstant(value, 50)).toEqual({
      costUsd: 10,
      unpricedModels: ["old"],
    });
    expect(costAtInstant(value, 100).costUsd).toBe(11);
    expect(costAtInstant(value, 199)).toEqual({
      costUsd: 11,
      unpricedModels: ["new", "old"],
    });
    expect(costAtInstant(value, 10_000).costUsd).toBe(15);
  });
});
