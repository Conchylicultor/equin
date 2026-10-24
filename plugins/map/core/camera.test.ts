import { describe, expect, test } from "bun:test";
import {
  SINGLE_POINT_ZOOM,
  boundsContain,
  cameraFor,
  overlayPositions,
} from "./camera";
import type { MapOverlay } from "./overlays";

describe("cameraFor", () => {
  test("no positions frames nothing", () => {
    expect(cameraFor([])).toEqual({ kind: "none" });
  });

  test("one position centres on it at street level", () => {
    expect(cameraFor([{ lat: 48.85, lng: 2.35 }])).toEqual({
      kind: "point",
      center: { lat: 48.85, lng: 2.35 },
      zoom: SINGLE_POINT_ZOOM,
    });
  });

  test("several positions at the same place are still a point", () => {
    const p = { lat: 1, lng: 2 };
    expect(cameraFor([p, { ...p }]).kind).toBe("point");
  });

  test("several positions fit their bounding box", () => {
    expect(
      cameraFor([
        { lat: 10, lng: -5 },
        { lat: -3, lng: 20 },
        { lat: 4, lng: 0 },
      ]),
    ).toEqual({
      kind: "bounds",
      bounds: { south: -3, west: -5, north: 10, east: 20 },
    });
  });
});

describe("overlayPositions", () => {
  test("collects pins, path points and area rings", () => {
    const overlays: MapOverlay[] = [
      { kind: "pin", id: "a", pinType: "x", position: { lat: 1, lng: 1 } },
      {
        kind: "path",
        id: "b",
        points: [
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
      },
      { kind: "area", id: "c", ring: [{ lat: 4, lng: 4 }] },
    ];
    expect(overlayPositions(overlays)).toEqual([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
      { lat: 4, lng: 4 },
    ]);
  });
});

describe("boundsContain", () => {
  const paris = { south: 48.8, west: 2.2, north: 48.9, east: 2.5 };
  const pacific = { south: -30, west: 170, north: 10, east: -170 };

  test("a point inside an ordinary box", () => {
    expect(boundsContain(paris, { lat: 48.85, lng: 2.35 })).toBe(true);
  });

  test("edges are inside", () => {
    expect(boundsContain(paris, { lat: 48.8, lng: 2.5 })).toBe(true);
  });

  test("outside by latitude or longitude", () => {
    expect(boundsContain(paris, { lat: 49, lng: 2.35 })).toBe(false);
    expect(boundsContain(paris, { lat: 48.85, lng: 2.6 })).toBe(false);
  });

  test("a box across the antimeridian holds both sides of it", () => {
    expect(boundsContain(pacific, { lat: 0, lng: 175 })).toBe(true);
    expect(boundsContain(pacific, { lat: 0, lng: -175 })).toBe(true);
    expect(boundsContain(pacific, { lat: 0, lng: 180 })).toBe(true);
    expect(boundsContain(pacific, { lat: 0, lng: 0 })).toBe(false);
  });

  test("an unwrapped longitude is compared wrapped", () => {
    expect(boundsContain(pacific, { lat: 0, lng: 185 })).toBe(true);
    expect(boundsContain(paris, { lat: 48.85, lng: 362.35 })).toBe(true);
  });

  test("the whole-world box holds every longitude", () => {
    const world = { south: -85, west: -180, north: 85, east: 180 };
    expect(boundsContain(world, { lat: 0, lng: 180 })).toBe(true);
    expect(boundsContain(world, { lat: 0, lng: -180 })).toBe(true);
    expect(boundsContain(world, { lat: 0, lng: 0 })).toBe(true);
  });

  test("an east edge on the antimeridian holds 180", () => {
    const b = { south: -10, west: 170, north: 10, east: 180 };
    expect(boundsContain(b, { lat: 0, lng: 180 })).toBe(true);
    expect(boundsContain(b, { lat: 0, lng: -179 })).toBe(false);
  });
});
