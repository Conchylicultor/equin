/**
 * Points bucketed on a grid of `radiusPx` cells, so a neighbourhood query only
 * walks the 3×3 cells around a point rather than every point. Shared by
 * clustering and spot grouping.
 */
export interface PixelPoint {
  id: string;
  x: number;
  y: number;
}

export interface PointGrid<P extends PixelPoint> {
  /** Every point within `radiusPx` of `at` (itself included), in no order. */
  near(at: PixelPoint): P[];
}

function cellOf(p: PixelPoint, radiusPx: number): [number, number] {
  return [Math.floor(p.x / radiusPx), Math.floor(p.y / radiusPx)];
}

export function pointGrid<P extends PixelPoint>(
  points: readonly P[],
  radiusPx: number,
): PointGrid<P> {
  if (!(radiusPx > 0)) {
    throw new Error(`pointGrid: radiusPx must be positive, got ${radiusPx}`);
  }
  const cells = new Map<string, P[]>();
  for (const p of points) {
    const [cx, cy] = cellOf(p, radiusPx);
    const key = `${cx},${cy}`;
    const bucket = cells.get(key);
    if (bucket === undefined) cells.set(key, [p]);
    else bucket.push(p);
  }
  const r2 = radiusPx * radiusPx;
  return {
    near(at) {
      const [cx, cy] = cellOf(at, radiusPx);
      const out: P[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const p of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            const ex = p.x - at.x;
            const ey = p.y - at.y;
            if (ex * ex + ey * ey <= r2) out.push(p);
          }
        }
      }
      return out;
    },
  };
}

/** Ascending id order — the deterministic tie-break both groupings use. */
export function byId(a: PixelPoint, b: PixelPoint): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
