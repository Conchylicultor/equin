import { describe, expect, test } from "bun:test";
import { NO_MAP_PADDING } from "./camera";
import { flyPath, uncoveredBounds, viewFor, type CameraView } from "./fly";

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

describe("uncoveredBounds", () => {
  const paris = { center: { lat: 48.85, lng: 2.35 }, zoom: 12 };

  test("no padding: a box centred on the view", () => {
    const b = uncoveredBounds(paris, VIEWPORT, NO_MAP_PADDING);
    expect((b.west + b.east) / 2).toBeCloseTo(2.35, 6);
    expect(b.south).toBeLessThan(48.85);
    expect(b.north).toBeGreaterThan(48.85);
    // 1000 px at zoom 12: 1000 / (256 · 4096) of 360°.
    expect(b.east - b.west).toBeCloseTo((1000 / (256 * 4096)) * 360, 6);
  });

  test("padding trims its own edge only", () => {
    const full = uncoveredBounds(paris, VIEWPORT, NO_MAP_PADDING);
    const b = uncoveredBounds(paris, VIEWPORT, {
      top: 0,
      right: 400,
      bottom: 0,
      left: 0,
    });
    expect(b.west).toBeCloseTo(full.west, 9);
    expect(b.north).toBeCloseTo(full.north, 9);
    expect(b.south).toBeCloseTo(full.south, 9);
    expect(b.east - b.west).toBeCloseTo(
      ((full.east - full.west) * 600) / 1000,
      9,
    );
  });

  test("a view across the antimeridian has west > east", () => {
    const b = uncoveredBounds(
      { center: { lat: 0, lng: 180 }, zoom: 4 },
      VIEWPORT,
      NO_MAP_PADDING,
    );
    expect(b.west).toBeGreaterThan(0);
    expect(b.east).toBeLessThan(0);
  });

  test("an uncovered width wider than the world is every longitude", () => {
    const b = uncoveredBounds(
      { center: { lat: 0, lng: 0 }, zoom: 0 },
      VIEWPORT,
      NO_MAP_PADDING,
    );
    expect(b.west).toBe(-180);
    expect(b.east).toBe(180);
    expect(b.north).toBeCloseTo(85.0511287798, 6);
    expect(b.south).toBeCloseTo(-85.0511287798, 6);
  });

  test("chrome covering everything leaves an empty box at the centre", () => {
    const b = uncoveredBounds(paris, VIEWPORT, {
      top: 500,
      right: 600,
      bottom: 500,
      left: 600,
    });
    expect(b.west).toBeCloseTo(b.east, 9);
    expect(b.south).toBeCloseTo(b.north, 9);
  });
});
