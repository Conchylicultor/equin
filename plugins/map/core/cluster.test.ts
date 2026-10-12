import { describe, expect, test } from "bun:test";
import {
  MIXED_PIN_TYPE,
  clusterPinType,
  clusterPins,
  type ClusterPoint,
} from "./cluster";

describe("clusterPins", () => {
  test("no points, no clusters", () => {
    expect(clusterPins([], 48)).toEqual([]);
  });

  test("far-apart points stay singletons", () => {
    const out = clusterPins(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 100, y: 0 },
      ],
      48,
    );
    expect(out).toEqual([
      { ids: ["a"], x: 0, y: 0 },
      { ids: ["b"], x: 100, y: 0 },
    ]);
  });

  test("points within the radius merge at their centroid", () => {
    const out = clusterPins(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 10, y: 0 },
        { id: "c", x: 0, y: 20 },
      ],
      48,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ids).toEqual(["a", "b", "c"]);
    expect(out[0]!.x).toBeCloseTo(10 / 3);
    expect(out[0]!.y).toBeCloseTo(20 / 3);
  });

  test("the radius is measured from the seed, not chained", () => {
    // b is within reach of a, c within reach of b but not of a.
    const out = clusterPins(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 40, y: 0 },
        { id: "c", x: 80, y: 0 },
      ],
      48,
    );
    expect(out.map((c) => c.ids)).toEqual([["a", "b"], ["c"]]);
  });

  test("a point exactly on the radius is inside", () => {
    const out = clusterPins(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 48, y: 0 },
      ],
      48,
    );
    expect(out.map((c) => c.ids)).toEqual([["a", "b"]]);
  });

  test("reaches across grid cells, including negative coordinates", () => {
    const out = clusterPins(
      [
        { id: "a", x: -1, y: -1 },
        { id: "b", x: 1, y: 1 },
      ],
      48,
    );
    expect(out.map((c) => c.ids)).toEqual([["a", "b"]]);
  });

  test("input order does not change the result", () => {
    const points: ClusterPoint[] = [
      { id: "d", x: 300, y: 5 },
      { id: "a", x: 0, y: 0 },
      { id: "c", x: 60, y: 0 },
      { id: "b", x: 30, y: 0 },
      { id: "e", x: 320, y: 10 },
    ];
    const forward = clusterPins(points, 48);
    const backward = clusterPins([...points].reverse(), 48);
    expect(backward).toEqual(forward);
    expect(forward.map((c) => c.ids)).toEqual([["a", "b"], ["c"], ["d", "e"]]);
  });

  test("every point lands in exactly one cluster", () => {
    const points: ClusterPoint[] = Array.from({ length: 200 }, (_, i) => ({
      id: `p${String(i).padStart(3, "0")}`,
      x: (i * 37) % 500,
      y: (i * 91) % 500,
    }));
    const ids = clusterPins(points, 48).flatMap((c) => c.ids);
    expect(ids.sort()).toEqual(points.map((p) => p.id).sort());
  });

  test("rejects a non-positive radius", () => {
    expect(() => clusterPins([], 0)).toThrow();
  });
});

describe("clusterPinType", () => {
  test("a uniform cluster is its pins' type", () => {
    expect(clusterPinType([{ pinType: "place" }, { pinType: "place" }])).toBe(
      "place",
    );
  });

  test("a mixed cluster is the mixed sentinel", () => {
    expect(clusterPinType([{ pinType: "place" }, { pinType: "stop" }])).toBe(
      MIXED_PIN_TYPE,
    );
  });

  test("an empty cluster is a bug", () => {
    expect(() => clusterPinType([])).toThrow();
  });
});
