import { describe, expect, test } from "bun:test";
import { groupSpots, pinStackOrder, type SpotPoint } from "./spots";

const pt = (id: string, x: number, rank = 0): SpotPoint => ({
  id,
  x,
  y: 0,
  rank,
});

describe("groupSpots", () => {
  test("no points, no spots", () => {
    expect(groupSpots([], 34)).toEqual([]);
  });

  test("far-apart pins are spots of one", () => {
    expect(groupSpots([pt("a", 0), pt("b", 100)], 34)).toEqual([
      { lead: "a", ids: ["a"] },
      { lead: "b", ids: ["b"] },
    ]);
  });

  test("the highest-ranked pin leads its spot, whatever its id", () => {
    const out = groupSpots([pt("a", 0), pt("b", 10, 1), pt("c", 20)], 34);
    expect(out).toEqual([{ lead: "b", ids: ["b", "a", "c"] }]);
  });

  test("a pin exactly at the radius joins; one past it does not", () => {
    const out = groupSpots([pt("a", 0, 1), pt("b", 34), pt("c", 35)], 34);
    expect(out).toEqual([
      { lead: "a", ids: ["a", "b"] },
      { lead: "c", ids: ["c"] },
    ]);
  });

  test("input order never changes the spots", () => {
    const pins = [pt("a", 0), pt("b", 20, 2), pt("c", 40), pt("d", 60, 1)];
    expect(groupSpots([...pins].reverse(), 34)).toEqual(groupSpots(pins, 34));
  });
});

describe("pinStackOrder", () => {
  test("higher rank draws above; the active pin above all", () => {
    const z = pinStackOrder(
      [{ id: "a", rank: 1 }, { id: "b" }, { id: "c", rank: 2 }],
      "b",
    );
    expect(z.get("b")).toBe(4);
    expect(z.get("c")!).toBeGreaterThan(z.get("a")!);
  });

  test("ties break by id, the same in any input order", () => {
    const a = pinStackOrder([{ id: "x" }, { id: "y" }], null);
    const b = pinStackOrder([{ id: "y" }, { id: "x" }], null);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});
