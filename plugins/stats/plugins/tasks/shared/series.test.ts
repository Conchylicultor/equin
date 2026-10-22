import { describe, expect, test } from "bun:test";
import { cumulativeSeries, velocitySeries } from "./series";

const days = [
  { date: "2026-01-01", added: 3, completed: 0, dropped: 0 },
  { date: "2026-01-03", added: 1, completed: 2, dropped: 1 },
];

describe("task history series", () => {
  test("cumulative keeps active = total − completed − dropped", () => {
    expect(cumulativeSeries(days)).toEqual([
      { date: "2026-01-01", total: 3, active: 3, completed: 0, dropped: 0 },
      { date: "2026-01-03", total: 4, active: 1, completed: 2, dropped: 1 },
    ]);
  });

  test("velocity net is resolved − added", () => {
    expect(velocitySeries(days).map((d) => d.net)).toEqual([-3, 2]);
  });
});
