import { describe, expect, test } from "bun:test";
import { metrics, report } from "../testing";
import { chartPoints, stackedParts } from "./chart-points";
import { kpiById } from "./kpis";

const visits = kpiById("visits");

function withSeries(returning: (number | null)[]) {
  return report({
    current: {
      from: "2026-06-14",
      to: "2026-06-15",
      summary: metrics({}),
      series: returning.map((r, i) => ({
        bucket: `2026-06-1${4 + i}`,
        metrics: metrics({ visits: 10, returningVisits: r }),
      })),
    },
  });
}

describe("visits chart", () => {
  test("stacks new visits under returning ones, adding up to the total", () => {
    const points = chartPoints(withSeries([3, 0]), visits);
    expect(stackedParts(visits, points)?.map((p) => p.id)).toEqual([
      "new",
      "returning",
    ]);
    expect(points.map((p) => [p.current, p.parts])).toEqual([
      [10, { new: 7, returning: 3 }],
      [10, { new: 10, returning: 0 }],
    ]);
  });

  test("a report that does not count returns draws the plain line", () => {
    const points = chartPoints(withSeries([3, null]), visits);
    expect(stackedParts(visits, points)).toBeNull();
  });

  test("a KPI without parts draws the plain line", () => {
    const visitors = kpiById("visitors");
    const points = chartPoints(withSeries([3, 0]), visitors);
    expect(stackedParts(visitors, points)).toBeNull();
  });
});
