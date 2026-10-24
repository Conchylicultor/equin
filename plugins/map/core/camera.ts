import type { LatLng, MapOverlay } from "./overlays";

/** Zoom used when the map frames a single point: street level. */
export const SINGLE_POINT_ZOOM = 15;

/**
 * Screen room, in px per edge, that chrome floating over the map covers (a
 * sidebar, a toolbar, a detail card). Framing keeps every pin out of it, and a
 * pin under it counts as off-screen.
 */
export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** No chrome over the map. */
export const NO_MAP_PADDING: MapPadding = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

/**
 * A lat/lng box. `west > east` is a box across the antimeridian (it runs east
 * from `west` past 180° to `east`); `west: -180, east: 180` is every longitude.
 */
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Wraps a longitude into [-180, 180). */
function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Whether `p` lies in `b`, edges included. Antimeridian-aware: a box with
 * `west > east` crosses it, and longitudes are compared wrapped, so 190° is
 * -170°.
 */
export function boundsContain(b: MapBounds, p: LatLng): boolean {
  if (p.lat < b.south || p.lat > b.north) return false;
  // Every longitude: also catches an east of 180 that wraps to -180.
  if (b.east - b.west >= 360) return true;
  const lng = wrapLng(p.lng);
  const west = wrapLng(b.west);
  // 180 is a legal east edge; wrapping would turn it into -180.
  const east = b.east === 180 ? 180 : wrapLng(b.east);
  if (lng === -180 && east === 180) return true;
  return west <= east ? lng >= west && lng <= east : lng >= west || lng <= east;
}

/**
 * How a renderer should frame a set of positions.
 *
 * - `none`   — nothing to frame (the host never mounts a renderer for this).
 * - `point`  — every position is the same place: centre on it at street level,
 *              because fitting a zero-area box would zoom to the maximum.
 * - `bounds` — fit the box that contains them all.
 */
export type MapCamera =
  | { kind: "none" }
  | { kind: "point"; center: LatLng; zoom: number }
  | { kind: "bounds"; bounds: MapBounds };

/** The overlays a camera frames: all but those marked `frame: false`. */
export function framingOverlays(overlays: readonly MapOverlay[]): MapOverlay[] {
  return overlays.filter((o) => o.frame !== false);
}

/** Every coordinate an overlay occupies — a pin's position, a path's points, an area's ring. */
export function overlayPositions(overlays: readonly MapOverlay[]): LatLng[] {
  const out: LatLng[] = [];
  for (const o of overlays) {
    switch (o.kind) {
      case "pin":
        out.push(o.position);
        break;
      case "path":
        out.push(...o.points);
        break;
      case "area":
        out.push(...o.ring);
        break;
    }
  }
  return out;
}

/**
 * The camera that shows every position. Does not handle a set straddling the
 * antimeridian (it frames the long way round) — acceptable for one page's
 * places, and a renderer with its own bounds type can refine it.
 */
export function cameraFor(positions: readonly LatLng[]): MapCamera {
  const first = positions[0];
  if (first === undefined) return { kind: "none" };

  let south = first.lat;
  let north = first.lat;
  let west = first.lng;
  let east = first.lng;
  for (const p of positions) {
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
  }

  if (south === north && west === east) {
    return { kind: "point", center: first, zoom: SINGLE_POINT_ZOOM };
  }
  return { kind: "bounds", bounds: { south, west, north, east } };
}
