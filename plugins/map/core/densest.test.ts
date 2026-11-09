import { describe, expect, test } from "bun:test";
import { densestPinIds } from "./densest";
import type { MapOverlay } from "./overlays";

const pin = (id: string, lat: number, lng: number): MapOverlay => ({
  kind: "pin",
  id,
  pinType: "t",
  position: { lat, lng },
});

/** `n` pins scattered a few km around a point. */
const around = (prefix: string, lat: number, lng: number, n: number) =>
  Array.from({ length: n }, (_, i) =>
    pin(
      `${prefix}${i}`,
      lat + ((i % 7) - 3) * 0.01,
      lng + ((i % 5) - 2) * 0.01,
    ),
  );

const sorted = (ids: readonly string[] | null) =>
  ids === null ? null : [...ids].sort();

describe("densestPinIds", () => {
  const paris = around("paris", 48.86, 2.35, 30);
  const lisbon = around("lisbon", 38.72, -9.14, 8);
  const tokyo = around("tokyo", 35.68, 139.7, 10);
  const versailles = pin("versailles", 48.8049, 2.1204);

  test("a home city and a few trips: the home city and its day trips", () => {
    expect(
      sorted(densestPinIds([...lisbon, ...paris, versailles, ...tokyo])),
    ).toEqual(sorted([...paris, versailles].map((p) => p.id)));
  });

  test("the answer does not depend on the pins' order", () => {
    const all = [...lisbon, ...paris, ...tokyo];
    expect(sorted(densestPinIds(all))).toEqual(
      sorted(densestPinIds([...all].reverse())),
    );
  });

  test("a tie is broken by position, never by order", () => {
    const a = around("a", 48.86, 2.35, 5);
    const b = around("b", 52.52, 13.4, 5);
    expect(densestPinIds([...a, ...b])).toEqual(densestPinIds([...b, ...a]));
  });

  test("an area split over two cells with an empty one between them still counts as one", () => {
    // ~1.4 cells apart at the equator: in cells two apart, one empty between.
    const west = pin("w", 0.1, 0.1);
    const east = pin("e", 0.1, 1.5);
    const far = pin("far", 40, 100);
    expect(sorted(densestPinIds([west, east, far]))).toEqual(["e", "w"]);
  });

  test("nothing to narrow: no pin, every pin in one area, or no area of two", () => {
    expect(densestPinIds([])).toBeNull();
    expect(densestPinIds(paris)).toBeNull();
    expect(densestPinIds([pin("x", 0, 0), pin("y", 40, 100)])).toBeNull();
  });

  test("paths and areas are left out", () => {
    const path: MapOverlay = {
      kind: "path",
      id: "route",
      points: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
    };
    expect(densestPinIds([path, ...paris, ...lisbon])).not.toContain("route");
  });
});
