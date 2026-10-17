import { describe, expect, test } from "bun:test";
import { wheelZoomLevels } from "./wheel-zoom";

describe("wheelZoomLevels", () => {
  test("a 100 px mouse notch zooms 0.4 level at speed 1, scaled by speed", () => {
    expect(
      wheelZoomLevels({ deltaY: -100, deltaMode: 0, ctrlKey: false }, 1, 800),
    ).toBeCloseTo(0.4);
    expect(
      wheelZoomLevels({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 0.5, 800),
    ).toBeCloseTo(-0.2);
  });

  test("line and page deltas are converted to pixels", () => {
    expect(
      wheelZoomLevels({ deltaY: -3, deltaMode: 1, ctrlKey: false }, 1, 800),
    ).toBeCloseTo(48 / 250);
    expect(
      wheelZoomLevels({ deltaY: -1, deltaMode: 2, ctrlKey: false }, 1, 200),
    ).toBeCloseTo(0.8);
  });

  test("one huge scroll event moves at most one level", () => {
    expect(
      wheelZoomLevels({ deltaY: -2000, deltaMode: 0, ctrlKey: false }, 1, 800),
    ).toBe(1);
    expect(
      wheelZoomLevels({ deltaY: 2000, deltaMode: 0, ctrlKey: false }, 4, 800),
    ).toBe(-1);
  });

  test("a pinch follows the fingers and ignores the speed", () => {
    // deltaY = -100·ln(2): the fingers doubled the scale — one level in.
    const doubled = { deltaY: -100 * Math.LN2, deltaMode: 0, ctrlKey: true };
    expect(wheelZoomLevels(doubled, 1, 800)).toBeCloseTo(1);
    expect(wheelZoomLevels(doubled, 3, 800)).toBeCloseTo(1);
  });
});

/** A flat stand-in for google.maps: a camera, a Mercator-free projection. */
function fakeMap(zoom: number) {
  const listeners = new Map<string, (e: unknown) => void>();
  let camera = { lat: 0, lng: 0, zoom };
  const div = {
    clientHeight: 800,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
    }),
    addEventListener: (type: string, fn: (e: unknown) => void) =>
      listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const map = {
    getDiv: () => div,
    get: () => undefined,
    getZoom: () => camera.zoom,
    getCenter: () => ({ lat: () => camera.lat, lng: () => camera.lng }),
    getProjection: () => ({
      fromLatLngToPoint: (c: { lat: () => number; lng: () => number }) => ({
        x: c.lng(),
        y: c.lat(),
      }),
      fromPointToLatLng: (p: { x: number; y: number }) => ({
        lat: () => p.y,
        lng: () => p.x,
      }),
    }),
    moveCamera: (v: {
      center?: { lat: () => number; lng: () => number };
      zoom: number;
    }) => {
      camera = {
        lat: v.center?.lat() ?? camera.lat,
        lng: v.center?.lng() ?? camera.lng,
        zoom: v.zoom,
      };
    },
  };
  const wheel = (deltaY: number, at = { x: 500, y: 400 }) =>
    listeners.get("wheel")?.({
      deltaY,
      deltaMode: 0,
      ctrlKey: false,
      clientX: at.x,
      clientY: at.y,
      preventDefault: () => {},
    });
  return {
    map: map as unknown as google.maps.Map,
    wheel,
    camera: () => camera,
  };
}

describe("attachWheelZoom", () => {
  let frames: FrameRequestCallback[] = [];
  let clock = 1000;
  const g = globalThis as Record<string, unknown>;
  g.google = {
    maps: {
      Point: class {
        constructor(
          public x: number,
          public y: number,
        ) {}
      },
    },
  };
  g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
  g.cancelAnimationFrame = () => {
    frames = [];
  };
  const runFrames = (n: number, rafLagMs = 0) => {
    for (let i = 0; i < n && frames.length > 0; i++) {
      clock += 16;
      const due = frames;
      frames = [];
      // A frame's timestamp is its start, which can precede the event's now.
      for (const cb of due) cb(clock - rafLagMs);
    }
  };

  test("a scroll up glides in toward its target, never out", async () => {
    const { attachWheelZoom } = await import("./wheel-zoom");
    const realNow = performance.now.bind(performance);
    performance.now = () => clock;
    try {
      const f = fakeMap(3);
      attachWheelZoom(f.map, () => 1);
      f.wheel(-250);
      f.wheel(-100);
      const seen: number[] = [];
      for (let i = 0; i < 60; i++) {
        runFrames(1, 12);
        seen.push(f.camera().zoom);
      }
      expect(Math.min(...seen)).toBeGreaterThanOrEqual(3);
      expect(f.camera().zoom).toBeCloseTo(4.4, 2);
    } finally {
      performance.now = realNow;
    }
  });
});
