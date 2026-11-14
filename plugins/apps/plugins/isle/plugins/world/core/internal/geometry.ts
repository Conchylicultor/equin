// Polylines: splines through waypoints, nearest-point queries, arc lengths, and
// a spatial hash of polyline samples ("is a road near here?").

import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";

/** A point `[x, y]` in world px. */
export type Pt = readonly [number, number];

/** Catmull-Rom through waypoints, `per` samples a span. */
export function spline(pts: readonly Pt[], per = 14): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (j: 0 | 1) =>
        0.5 *
        (2 * p1[j] +
          (-p0[j] + p2[j]) * t +
          (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 +
          (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      out.push([c(0), c(1)]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** The nearest point of polyline `p` to (x, y): distance, segment end index, point. */
export function segDist(
  p: readonly Pt[],
  x: number,
  y: number,
): { d: number; i: number; x: number; y: number } {
  let best = 1e9;
  let bi = 0;
  let bx = 0;
  let by = 0;
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1]!;
    const [cx, cy] = p[i]!;
    const dx = cx - ax;
    const dy = cy - ay;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d = Math.hypot(x - qx, y - qy);
    if (d < best) {
      best = d;
      bi = i;
      bx = qx;
      by = qy;
    }
  }
  return { d: best, i: bi, x: bx, y: by };
}

/** A wandering quadratic from a to b, as an 11-point polyline. */
export function curve(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bend: number,
): Pt[] {
  const mx = (ax + bx) / 2 + (ay - by) * bend;
  const my = (ay + by) / 2 + (bx - ax) * bend;
  const pts: Pt[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const u = 1 - t;
    pts.push([
      u * u * ax + 2 * u * t * mx + t * t * bx,
      u * u * ay + 2 * u * t * my + t * t * by,
    ]);
  }
  return pts;
}

/** Cumulative arc length at each point of a polyline. */
export function arcsOf(pts: readonly Pt[]): number[] {
  const a = [0];
  for (let i = 1; i < pts.length; i++) {
    a.push(
      a[i - 1]! +
        Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]),
    );
  }
  return a;
}

/** A polyline cut at arc length L. */
export function cutAt(
  pts: readonly Pt[],
  arc: readonly number[],
  L: number,
): Pt[] {
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    if (arc[i]! <= L) {
      out.push(pts[i]!);
      continue;
    }
    const f = (L - arc[i - 1]!) / Math.max(1e-6, arc[i]! - arc[i - 1]!);
    out.push([
      pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * f,
      pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * f,
    ]);
    break;
  }
  return out;
}

/** A road from a to b: a spline bent to one side by an amount seeded from `key`. */
export function roadCurve(a: Pt, b: Pt, key: string, bendK = 0.22): Pt[] {
  const h = fnv1a32(key);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bend = ((h % 1000) / 1000 - 0.5) * bendK * L;
  const nx = -(b[1] - a[1]) / (L || 1);
  const ny = (b[0] - a[0]) / (L || 1);
  const m1: Pt = [
    a[0] + (b[0] - a[0]) * 0.33 + nx * bend * 0.8,
    a[1] + (b[1] - a[1]) * 0.33 + ny * bend * 0.8,
  ];
  const m2: Pt = [
    a[0] + (b[0] - a[0]) * 0.66 + nx * bend * 0.6,
    a[1] + (b[1] - a[1]) * 0.66 + ny * bend * 0.6,
  ];
  return spline([a, m1, m2, b], Math.max(4, Math.round(L / 60)));
}

/** A spatial hash of points, for "is anything within r of here?" queries. */
export interface PointIndex {
  add(x: number, y: number): void;
  addLine(pts: readonly Pt[], step?: number): void;
  near(x: number, y: number, r: number): boolean;
  inRect(x0: number, y0: number, x1: number, y1: number): boolean;
}

export function pointIndex(cell = 64): PointIndex {
  const m = new Map<number, number[]>();
  const key = (i: number, j: number) => (i * 73856093) ^ (j * 19349663);
  const idx: PointIndex = {
    add(x, y) {
      const k = key(Math.floor(x / cell), Math.floor(y / cell));
      let a = m.get(k);
      if (!a) m.set(k, (a = []));
      a.push(x, y);
    },
    addLine(pts, step = 8) {
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1]!;
        const [bx, by] = pts[i]!;
        const L = Math.hypot(bx - ax, by - ay);
        for (let s = 0; s < L; s += step)
          idx.add(ax + ((bx - ax) * s) / L, ay + ((by - ay) * s) / L);
      }
      const last = pts[pts.length - 1];
      if (last) idx.add(last[0], last[1]);
    },
    near(x, y, r) {
      const i0 = Math.floor((x - r) / cell);
      const i1 = Math.floor((x + r) / cell);
      const j0 = Math.floor((y - r) / cell);
      const j1 = Math.floor((y + r) / cell);
      const r2 = r * r;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const a = m.get(key(i, j));
          if (!a) continue;
          for (let k = 0; k < a.length; k += 2) {
            const dx = a[k]! - x;
            const dy = a[k + 1]! - y;
            if (dx * dx + dy * dy < r2) return true;
          }
        }
      }
      return false;
    },
    inRect(x0, y0, x1, y1) {
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
        for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
          const a = m.get(key(i, j));
          if (!a) continue;
          for (let k = 0; k < a.length; k += 2) {
            if (a[k]! > x0 && a[k]! < x1 && a[k + 1]! > y0 && a[k + 1]! < y1)
              return true;
          }
        }
      }
      return false;
    },
  };
  return idx;
}
