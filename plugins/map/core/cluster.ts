/**
 * Pin clustering, as pure geometry: points already projected to screen pixels
 * in, groups out. No vendor, no map — a renderer projects its pins at the
 * current zoom and hands them here.
 */
import { byId, pointGrid, type PixelPoint } from "./grid";

/** A pin projected to pixels at the zoom being clustered. */
export type ClusterPoint = PixelPoint;

/** A group of pins drawn as one mark. A lone pin is a group of one. */
export interface PinCluster {
  /** Never empty; the first id is the group's seed. */
  ids: string[];
  /** The members' centroid, in the same pixel space as the input. */
  x: number;
  y: number;
}

/**
 * Greedy clustering: in id order, every point not yet taken seeds a group and
 * takes every other free point within `radiusPx` of the seed.
 *
 * Deterministic and order-insensitive — the same points in any order give the
 * same groups — so a re-render that reorders the pins never reshuffles the map.
 * Points are bucketed on a grid of `radiusPx` cells, so a seed only looks at its
 * 3×3 neighbourhood rather than every point.
 */
export function clusterPins(
  points: readonly ClusterPoint[],
  radiusPx: number,
): PinCluster[] {
  if (!(radiusPx > 0)) {
    throw new Error(`clusterPins: radiusPx must be positive, got ${radiusPx}`);
  }
  const sorted = [...points].sort(byId);
  const grid = pointGrid(sorted, radiusPx);
  const taken = new Set<ClusterPoint>();
  const out: PinCluster[] = [];
  for (const seed of sorted) {
    if (taken.has(seed)) continue;
    taken.add(seed);
    const members = [seed];
    for (const p of grid.near(seed)) {
      if (taken.has(p)) continue;
      taken.add(p);
      members.push(p);
    }
    // Neighbouring cells were walked out of id order; restore it after the seed.
    const rest = members.slice(1).sort(byId);
    const all = [seed, ...rest];
    let sx = 0;
    let sy = 0;
    for (const m of all) {
      sx += m.x;
      sy += m.y;
    }
    out.push({
      ids: all.map((m) => m.id),
      x: sx / all.length,
      y: sy / all.length,
    });
  }
  return out;
}

/** The radius a map clusters at when the caller does not say. */
export const DEFAULT_CLUSTER_RADIUS_PX = 48;

/**
 * The `pinType` a cluster stands for — the dispatch key of `GeoMap.Cluster`.
 * A cluster whose pins all share a type is that type's cluster; a mixed one
 * gets {@link MIXED_PIN_TYPE}, which no layer uses as a pin type, so it lands
 * on the neutral fallback rather than wearing one layer's look over another's
 * pins.
 */
export function clusterPinType(pins: readonly { pinType: string }[]): string {
  const first = pins[0];
  if (first === undefined) {
    throw new Error("clusterPinType: a cluster has at least one pin");
  }
  return pins.every((p) => p.pinType === first.pinType)
    ? first.pinType
    : MIXED_PIN_TYPE;
}

/** The dispatch key of a cluster mixing pin types. */
export const MIXED_PIN_TYPE = "\u0000mixed";
