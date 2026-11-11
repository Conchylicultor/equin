import type { MapOverlay } from "./overlays";

/**
 * The side of one cell of the density grid, in Web-Mercator units (the world
 * is 1×1): a zoom-9 tile — ~78 km at the equator, ~50 km at Paris' latitude,
 * about one metropolitan area. A block of 3×3 cells (~150 km at Paris) holds a
 * city and its day trips, and a city straddling a cell edge still falls in one
 * block.
 */
const CELL = 1 / 2 ** 9;

/** Web-Mercator x / y of a latitude / longitude, each in [0, 1). */
function mercator(lat: number, lng: number): { x: number; y: number } {
  const sin = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

/**
 * How far past a quartile a pin may lie, in interquartile ranges, before it is
 * an outlier of its area — Tukey's "far out" fence. The inner one (1.5) is too
 * tight for a city whose pins crowd its centre: it cuts the outer districts.
 */
const FENCE = 3;

/** The `q` quantile of sorted values (linear between the two nearest). */
function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** The [low, high] fence of the values: Tukey's, past which one is an outlier. */
function fence(values: number[]): readonly [number, number] {
  values.sort((a, b) => a - b);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const reach = (q3 - q1) * FENCE;
  return [q1 - reach, q3 + reach];
}

/**
 * The pins of the densest area — the ids a map opening on "where most of the
 * pins are" frames, instead of every pin (which, for a set spread over a few
 * trips, is the whole world). The pins are bucketed on a fixed Mercator grid
 * (`CELL`); the area is the 3×3 block of cells holding the most pins, ties
 * broken by the block's position, so the answer depends only on the pins, never
 * on their order. The block's own outliers are then left out — a pin past
 * Tukey's fence (`FENCE`) on either Mercator axis, such as a day trip out of
 * the city — so the map opens on the city itself, not on its region. O(pins
 * log pins).
 *
 * `null` when narrowing would not help: no pin, a densest block holding a
 * single pin (a set too sparse to have an area), or every pin kept — the
 * caller then frames every overlay as before. Only pins count; paths and
 * areas are left to the plain framing. The grid does not wrap at the
 * antimeridian: a cluster straddling ±180° counts as two.
 */
export function densestPinIds(
  overlays: readonly MapOverlay[],
): readonly string[] | null {
  const cells = new Map<
    string,
    { cx: number; cy: number; pins: { id: string; x: number; y: number }[] }
  >();
  let pins = 0;
  for (const o of overlays) {
    if (o.kind !== "pin") continue;
    pins++;
    const { x, y } = mercator(o.position.lat, o.position.lng);
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    const key = `${cx},${cy}`;
    const cell = cells.get(key);
    const entry = { id: o.id, x, y };
    if (cell === undefined) cells.set(key, { cx, cy, pins: [entry] });
    else cell.pins.push(entry);
  }
  if (pins === 0) return null;

  // Every block centre that can hold a pin: an occupied cell or one of its
  // neighbours — a city split over two cells with an empty one between them
  // is best framed from that middle cell.
  const centres = new Map<string, { cx: number; cy: number }>();
  for (const { cx, cy } of cells.values())
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        centres.set(`${cx + dx},${cy + dy}`, { cx: cx + dx, cy: cy + dy });

  let best: { cx: number; cy: number; count: number } | null = null;
  for (const { cx, cy } of centres.values()) {
    let count = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        count += cells.get(`${cx + dx},${cy + dy}`)?.pins.length ?? 0;
    if (
      best === null ||
      count > best.count ||
      (count === best.count &&
        (cy < best.cy || (cy === best.cy && cx < best.cx)))
    ) {
      best = { cx, cy, count };
    }
  }
  if (best === null || best.count < 2) return null;

  const block: { id: string; x: number; y: number }[] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      block.push(...(cells.get(`${best.cx + dx},${best.cy + dy}`)?.pins ?? []));
  const [x0, x1] = fence(block.map((p) => p.x));
  const [y0, y1] = fence(block.map((p) => p.y));
  const ids = block
    .filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
    .map((p) => p.id);
  return ids.length === pins ? null : ids;
}
