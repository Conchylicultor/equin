/**
 * Spots: the Google-Maps way of handling a crowd. Nothing is hidden — every
 * pin stays drawn — but pins that sit on (nearly) the same spot on screen are
 * read as one place on the map, led by its most important pin, which carries
 * the spot's size. Pure geometry, like clustering: pixel points in, spots out.
 */
import { byId, pointGrid, type PixelPoint } from "./grid";

/** A pin projected to pixels, with its importance (`MapPin.rank`, default 0). */
export interface SpotPoint extends PixelPoint {
  rank: number;
}

/** One spot. A lone pin is a spot of one. */
export interface PinSpot {
  /** The spot's most important pin: it draws on top and carries the count. */
  lead: string;
  /** Every pin of the spot, the lead first. */
  ids: string[];
}

/** Most important first: higher rank, then ascending id. */
function byImportance(a: SpotPoint, b: SpotPoint): number {
  return b.rank - a.rank || byId(a, b);
}

/**
 * Greedy grouping, most important first: every pin not yet taken leads a spot
 * and takes every other free pin within `radiusPx` of it. Deterministic and
 * input-order-insensitive, like `clusterPins`.
 */
export function groupSpots(
  points: readonly SpotPoint[],
  radiusPx: number,
): PinSpot[] {
  const sorted = [...points].sort(byImportance);
  const grid = pointGrid(sorted, radiusPx);
  const taken = new Set<SpotPoint>();
  const out: PinSpot[] = [];
  for (const lead of sorted) {
    if (taken.has(lead)) continue;
    taken.add(lead);
    const rest: SpotPoint[] = [];
    for (const p of grid.near(lead)) {
      if (taken.has(p)) continue;
      taken.add(p);
      rest.push(p);
    }
    rest.sort(byImportance);
    out.push({ lead: lead.id, ids: [lead.id, ...rest.map((p) => p.id)] });
  }
  return out;
}

/**
 * The stacking order of overlapping pins: a z-index per pin id, from 1 up —
 * the more important pin draws above the less important one (rank, then id),
 * and the active pin above them all, so a grown selection is never half-hidden.
 */
export function pinStackOrder(
  pins: readonly { id: string; rank?: number }[],
  activeId: string | null,
): Map<string, number> {
  const ordered = pins
    .map((p) => ({ id: p.id, x: 0, y: 0, rank: p.rank ?? 0 }))
    .sort(byImportance)
    .reverse();
  const z = new Map<string, number>();
  ordered.forEach((p, i) => z.set(p.id, i + 1));
  if (activeId !== null && z.has(activeId)) z.set(activeId, ordered.length + 1);
  return z;
}

/** How close (screen px) two pins sit to share a spot, unless the caller says. */
export const DEFAULT_SPOT_RADIUS_PX = 34;

/**
 * The zoom from which pins are drawn near (full pins, no spot counts); below
 * it they are drawn far (compact marks, one count per spot).
 */
export const DEFAULT_SPOT_NEAR_ZOOM = 13;
