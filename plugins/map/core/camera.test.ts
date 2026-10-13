import { describe, expect, test } from "bun:test";
import { SINGLE_POINT_ZOOM, cameraFor, overlayPositions } from "./camera";
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
