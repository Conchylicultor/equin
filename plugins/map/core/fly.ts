import type { MapCamera, MapPadding } from "./camera";
import type { LatLng } from "./overlays";

// Camera motion, vendor-free: where a framing puts the map (`viewFor`) and the
// smooth path from one view to another (`flyPath`) — so a renderer only plays
// frames, and every renderer flies the same way.

/** A map position and zoom: what a camera shows. */
export interface CameraView {
  center: LatLng;
  zoom: number;
}

/** The map's size on screen, in CSS px. */
export interface MapViewport {
  width: number;
  height: number;
}

/** A path between two views: `at(0)` is the start, `at(1)` the end. */
export interface FlyPath {
  /** How long the flight should take, in ms (0 when there is nowhere to go). */
  durationMs: number;
  at: (t: number) => CameraView;
}

/** Web Mercator world size at zoom 0, in px (one 256px tile). */
const WORLD_PX = 256;
const MAX_LAT = 85.0511287798;

interface WorldPoint {
  x: number;
  y: number;
}

function project({ lat, lng }: LatLng): WorldPoint {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * WORLD_PX,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * WORLD_PX,
  };
}

function unproject({ x, y }: WorldPoint): LatLng {
  const n = Math.PI - (2 * Math.PI * y) / WORLD_PX;
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    lng: (x / WORLD_PX) * 360 - 180,
  };
}

/**
 * The view a framing puts the map in: a bounds fitted into the area the
 * padding leaves uncovered (at a whole zoom, so raster tiles land crisp, and
 * at most `maxZoom`), a point centred there at its own zoom. The centre is
 * shifted so the framed area's middle is the uncovered area's middle.
 */
export function viewFor(
  camera: Exclude<MapCamera, { kind: "none" }>,
  viewport: MapViewport,
  padding: MapPadding,
  maxZoom: number,
): CameraView {
  let mid: WorldPoint;
  let zoom: number;
  if (camera.kind === "point") {
    mid = project(camera.center);
    zoom = camera.zoom;
  } else {
    const { south, west, north, east } = camera.bounds;
    const sw = project({ lat: south, lng: west });
    const ne = project({ lat: north, lng: east });
    mid = { x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2 };
    const room = {
      width: Math.max(1, viewport.width - padding.left - padding.right),
      height: Math.max(1, viewport.height - padding.top - padding.bottom),
    };
    const fit = Math.log2(
      Math.min(
        room.width / Math.max(ne.x - sw.x, 1e-9),
        room.height / Math.max(sw.y - ne.y, 1e-9),
      ),
    );
    zoom = Math.max(0, Math.min(maxZoom, Math.floor(fit)));
  }
  const scale = 2 ** zoom;
  return {
    center: unproject({
      x: mid.x - (padding.left - padding.right) / 2 / scale,
      y: mid.y - (padding.top - padding.bottom) / 2 / scale,
    }),
    zoom,
  };
}

/** Curvature of the flight: how far it zooms out to travel (van Wijk & Nuij's ρ). */
const RHO = 1.42;
/** Flight speed, in screenfuls per second along the path. */
const SPEED = 1.2;
const MIN_FLIGHT_MS = 300;
const MAX_FLIGHT_MS = 1600;

/**
 * The smooth zoom-and-pan from `from` to `to` (van Wijk & Nuij, "Smooth and
 * efficient zooming and panning" — the path map apps fly): a far jump zooms
 * out, glides, and zooms back in; a near one mostly pans; a zoom alone just
 * zooms. Each frame's zoom is fractional — the renderer draws in-between zooms
 * while it flies. Unrelated to the antimeridian (it flies the long way round).
 */
export function flyPath(
  from: CameraView,
  to: CameraView,
  viewport: MapViewport,
): FlyPath {
  const scale0 = 2 ** from.zoom;
  const p0 = project(from.center);
  const p1 = project(to.center);
  // Everything below is in px at the start zoom.
  const w0 = Math.max(viewport.width, viewport.height);
  const w1 = w0 / 2 ** (to.zoom - from.zoom);
  const u1 = Math.hypot((p1.x - p0.x) * scale0, (p1.y - p0.y) * scale0);
  const rho2 = RHO * RHO;
  const r = (i: 0 | 1) => {
    const b =
      (w1 * w1 - w0 * w0 + (i === 0 ? 1 : -1) * rho2 * rho2 * u1 * u1) /
      (2 * (i === 0 ? w0 : w1) * rho2 * u1);
    return Math.log(Math.sqrt(b * b + 1) - b);
  };

  let S: number;
  let width: (s: number) => number; // the view's width relative to w0
  let travelled: (s: number) => number; // the fraction of the way across
  const r0 = u1 > 1e-6 ? r(0) : 0;
  const pathS = u1 > 1e-6 ? (r(1) - r0) / RHO : Number.NaN;
  if (Number.isFinite(pathS)) {
    S = pathS;
    width = (s) => Math.cosh(r0) / Math.cosh(r0 + RHO * s);
    travelled = (s) =>
      (w0 * (Math.cosh(r0) * Math.tanh(r0 + RHO * s) - Math.sinh(r0))) /
      rho2 /
      u1;
  } else {
    // No distance to travel: a pure zoom (or nothing at all).
    const k = w1 < w0 ? -1 : 1;
    S = Math.abs(Math.log(w1 / w0)) / RHO;
    width = (s) => Math.exp(k * RHO * s);
    travelled = () => 1;
  }

  const at = (t: number): CameraView => {
    if (t >= 1) return to;
    if (t <= 0) return from;
    const s = t * S;
    const f = travelled(s);
    return {
      center: unproject({
        x: p0.x + (p1.x - p0.x) * f,
        y: p0.y + (p1.y - p0.y) * f,
      }),
      zoom: from.zoom + Math.log2(1 / width(s)),
    };
  };
  const durationMs =
    S < 1e-6
      ? 0
      : Math.max(MIN_FLIGHT_MS, Math.min(MAX_FLIGHT_MS, (1000 * S) / SPEED));
  return { durationMs, at };
}
