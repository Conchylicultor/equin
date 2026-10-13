import { describe, expect, test } from "bun:test";
import { NO_MAP_PADDING } from "./camera";
import { flyPath, viewFor, type CameraView } from "./fly";

const VIEWPORT = { width: 1000, height: 800 };

function near(a: CameraView, b: CameraView) {
  expect(a.zoom).toBeCloseTo(b.zoom, 6);
  expect(a.center.lat).toBeCloseTo(b.center.lat, 6);
  expect(a.center.lng).toBeCloseTo(b.center.lng, 6);
}

describe("viewFor", () => {
  test("a point keeps its zoom and is centred", () => {
    const v = viewFor(
      { kind: "point", center: { lat: 48.85, lng: 2.35 }, zoom: 15 },
      VIEWPORT,
      NO_MAP_PADDING,
      18,
    );
    near(v, { center: { lat: 48.85, lng: 2.35 }, zoom: 15 });
  });

  test("bounds fit at a whole zoom, capped", () => {
    const paris = {
      kind: "bounds" as const,
      bounds: { south: 48.85, west: 2.29, north: 48.87, east: 2.38 },
    };
    const v = viewFor(paris, VIEWPORT, NO_MAP_PADDING, 18);
    expect(Number.isInteger(v.zoom)).toBe(true);
    expect(v.zoom).toBe(13);
    expect(viewFor(paris, VIEWPORT, NO_MAP_PADDING, 10).zoom).toBe(10);
  });

  test("covered edges shift the centre away from them", () => {
    const camera = {
      kind: "point" as const,
      center: { lat: 0, lng: 0 },
      zoom: 4,
    };
    const v = viewFor(camera, VIEWPORT, { ...NO_MAP_PADDING, left: 200 }, 18);
    // The uncovered area is to the right, so the map centre sits left of the point.
    expect(v.center.lng).toBeLessThan(0);
    expect(v.center.lat).toBeCloseTo(0, 6);
  });
});

describe("flyPath", () => {
  const paris: CameraView = { center: { lat: 48.85, lng: 2.35 }, zoom: 13 };
  const tokyo: CameraView = { center: { lat: 35.68, lng: 139.69 }, zoom: 13 };

  test("starts and ends on the two views", () => {
    const path = flyPath(paris, tokyo, VIEWPORT);
    near(path.at(0), paris);
    near(path.at(1), tokyo);
  });

  test("a far jump zooms out on the way", () => {
    const path = flyPath(paris, tokyo, VIEWPORT);
    expect(path.at(0.5).zoom).toBeLessThan(paris.zoom - 3);
    expect(path.durationMs).toBeGreaterThan(0);
  });

  test("a zoom alone keeps the centre and moves the zoom monotonically", () => {
    const out: CameraView = { ...paris, zoom: 10 };
    const path = flyPath(paris, out, VIEWPORT);
    const zooms = [0, 0.25, 0.5, 0.75, 1].map((t) => path.at(t).zoom);
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i]!).toBeLessThanOrEqual(zooms[i - 1]!);
    }
    expect(path.at(0.5).center.lat).toBeCloseTo(paris.center.lat, 6);
  });

  test("going nowhere takes no time", () => {
    expect(flyPath(paris, paris, VIEWPORT).durationMs).toBe(0);
  });
});
