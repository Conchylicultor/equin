// Walking: a 16 px cost grid over the world's extent (land is walkable, roads
// and squares cheaper, buildings and solid scenery blocked, the shallows
// dearer) and A* over it with line-of-sight smoothing. (The prototype sampled
// the line of sight; here it walks the segment's supercover, so a smoothed
// path cannot clip a blocked cell's corner.)

import type { Pt } from "./geometry";
import type { Layout } from "./layout";
import type { WorldModel } from "./world-model";

export const WALK_CELL = 16;

/** Something solid the walker goes round: `[x, y, radius]` (a rock, a tree, a lamp post). */
export type Solid = readonly [number, number, number];

export interface WalkGrid {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  /** Per cell: 0 blocked, else the cost of crossing it (1 road, 1.7 shallows' edge, 2.4 land). */
  readonly cost: Float32Array;
}

/** The walk grid of a layout, with the scenery's `solids` stamped in. */
export function walkGrid(
  M: WorldModel,
  layout: Layout,
  solids: readonly Solid[] = [],
): WalkGrid {
  const C = WALK_CELL;
  const [rx0, ry0, rx1, ry1] = layout.rect;
  const x0 = Math.floor(rx0 / C) * C;
  const y0 = Math.floor(ry0 / C) * C;
  const w = Math.ceil((rx1 - x0) / C);
  const h = Math.ceil((ry1 - y0) / C);
  const cost = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const hv = M.heightAt(
        x0 + (i + 0.5) * C,
        y0 + (j + 0.5) * C,
        layout.islands,
      );
      cost[j * w + i] = hv > 0.05 ? (hv < 0.075 ? 1.7 : 2.4) : 0;
    }
  }
  const stamp = (
    x: number,
    y: number,
    r: number,
    v: number,
    mode: "road" | "set",
  ) => {
    for (
      let j = Math.max(0, Math.floor((y - r - y0) / C));
      j <= Math.min(h - 1, Math.floor((y + r - y0) / C));
      j++
    ) {
      for (
        let i = Math.max(0, Math.floor((x - r - x0) / C));
        i <= Math.min(w - 1, Math.floor((x + r - x0) / C));
        i++
      ) {
        if (
          Math.hypot(x0 + (i + 0.5) * C - x, y0 + (j + 0.5) * C - y) >
          r + C * 0.35
        )
          continue;
        const k = j * w + i;
        if (mode === "road") {
          if (cost[k]! > 0) cost[k] = Math.min(cost[k]!, v);
        } else cost[k] = v;
      }
    }
  };
  for (const rd of layout.roads) {
    rd.samples.forEach((s, i) => {
      if (i % 2) return;
      if (s.bridge) stamp(s.x, s.y, 12, 1, "set");
      else stamp(s.x, s.y, rd.R * 0.6, 1, "road");
    });
  }
  for (const q of layout.squares) stamp(q.x, q.y, q.r * 0.85, 1, "road");
  for (const [x, y, r] of solids) stamp(x, y, r, 0, "set");
  for (const b of layout.buildings) {
    for (
      let j = Math.floor((b.y - b.depth - y0) / C);
      j <= Math.floor((b.y - 2 - y0) / C);
      j++
    ) {
      for (
        let i = Math.floor((b.x - b.w / 2 + 4 - x0) / C);
        i <= Math.floor((b.x + b.w / 2 - 4 - x0) / C);
        i++
      ) {
        if (i >= 0 && j >= 0 && i < w && j < h) cost[j * w + i] = 0;
      }
    }
    stamp(b.door[0], b.door[1] + 6, 10, 1, "set");
  }
  return { x0, y0, w, h, cost };
}

/** Whether a world point stands on a walkable cell. */
export function walkable(G: WalkGrid, x: number, y: number): boolean {
  const i = Math.floor((x - G.x0) / WALK_CELL);
  const j = Math.floor((y - G.y0) / WALK_CELL);
  return i >= 0 && j >= 0 && i < G.w && j < G.h && G.cost[j * G.w + i]! > 0;
}

/** A binary min-heap of cell indices keyed by f. */
function heap() {
  const a: number[] = [];
  const f: number[] = [];
  const swap = (i: number, j: number) => {
    [a[i], a[j]] = [a[j]!, a[i]!];
    [f[i], f[j]] = [f[j]!, f[i]!];
  };
  return {
    get size() {
      return a.length;
    },
    push(n: number, k: number) {
      a.push(n);
      f.push(k);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (f[p]! <= f[i]!) break;
        swap(p, i);
        i = p;
      }
    },
    pop(): number {
      const top = a[0]!;
      const ln = a.pop()!;
      const lf = f.pop()!;
      if (a.length) {
        a[0] = ln;
        f[0] = lf;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && f[l]! < f[m]!) m = l;
          if (r < a.length && f[r]! < f[m]!) m = r;
          if (m === i) break;
          swap(m, i);
          i = m;
        }
      }
      return top;
    },
  };
}

/**
 * The walk from (fx, fy) to (tx, ty): world points from the start cell to the
 * goal (the exact goal when it is walkable), smoothed to straight runs over
 * cells no dearer than their ends. Null when there is no way.
 */
export function findPath(
  G: WalkGrid,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
): Pt[] | null {
  const { w: GW, h: GH, cost } = G;
  const C = WALK_CELL;
  const cellOf = (x: number, y: number): [number, number] => [
    Math.max(0, Math.min(GW - 1, Math.floor((x - G.x0) / C))),
    Math.max(0, Math.min(GH - 1, Math.floor((y - G.y0) / C))),
  ];
  const nearestFree = ([i, j]: [number, number]): [number, number] | null => {
    if (cost[j * GW + i]! > 0) return [i, j];
    for (let r = 1; r < 10; r++) {
      let best: [number, number] | null = null;
      let bd = 1e9;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= GW || b >= GH || !(cost[b * GW + a]! > 0))
            continue;
          const d = di * di + dj * dj;
          if (d < bd) {
            bd = d;
            best = [a, b];
          }
        }
      }
      if (best) return best;
    }
    return null;
  };
  // A straight run from cell a to cell b is fine when every cell the segment
  // between their centres touches (its supercover) is walkable and no dearer
  // than its ends — so a smoothed path never clips a blocked cell's corner.
  const lineOK = (
    a: readonly [number, number],
    b: readonly [number, number],
  ) => {
    const [ai, aj] = a;
    const [bi, bj] = b;
    const lim = Math.max(cost[aj * GW + ai]!, cost[bj * GW + bi]!);
    const ok = (i: number, j: number) => {
      const c = cost[j * GW + i]!;
      return c > 0 && c <= lim + 0.01;
    };
    const nx = Math.abs(bi - ai);
    const ny = Math.abs(bj - aj);
    const di = Math.sign(bi - ai);
    const dj = Math.sign(bj - aj);
    let i = ai;
    let j = aj;
    if (!ok(i, j)) return false;
    for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
      const dec = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (dec === 0) {
        // through a corner: both cells beside it are touched too
        if (!ok(i + di, j) || !ok(i, j + dj)) return false;
        i += di;
        j += dj;
        ix++;
        iy++;
      } else if (dec < 0) {
        i += di;
        ix++;
      } else {
        j += dj;
        iy++;
      }
      if (!ok(i, j)) return false;
    }
    return true;
  };
  const s = nearestFree(cellOf(fx, fy));
  const e = nearestFree(cellOf(tx, ty));
  if (!s || !e) return null;
  const N = GW * GH;
  const gS = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = heap();
  const si = s[1] * GW + s[0];
  const ei = e[1] * GW + e[0];
  gS[si] = 0;
  open.push(si, 0);
  const hEst = (k: number) => {
    const dx = Math.abs((k % GW) - e[0]);
    const dy = Math.abs(((k / GW) | 0) - e[1]);
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
  };
  while (open.size) {
    const k = open.pop();
    if (k === ei) break;
    if (closed[k]) continue;
    closed[k] = 1;
    const i = k % GW;
    const j = (k / GW) | 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= GW || b >= GH) continue;
        const nk = b * GW + a;
        const c = cost[nk]!;
        if (!(c > 0) || closed[nk]) continue;
        if (di && dj && (!(cost[j * GW + a]! > 0) || !(cost[b * GW + i]! > 0)))
          continue;
        const ng = gS[k]! + c * (di && dj ? 1.414 : 1);
        if (ng < gS[nk]!) {
          gS[nk] = ng;
          came[nk] = k;
          open.push(nk, ng + hEst(nk));
        }
      }
    }
  }
  if (came[ei]! < 0 && si !== ei) return null;
  const cells: [number, number][] = [];
  for (let k = ei; k >= 0; k = k === si ? -1 : came[k]!)
    cells.push([k % GW, (k / GW) | 0]);
  cells.reverse();
  const pts: [number, number][] = [cells[0]!];
  let a = 0;
  while (a < cells.length - 1) {
    let b = cells.length - 1;
    while (b > a + 1 && !lineOK(cells[a]!, cells[b]!)) b--;
    pts.push(cells[b]!);
    a = b;
  }
  const out: Pt[] = pts.map(([i, j]) => [
    G.x0 + (i + 0.5) * C,
    G.y0 + (j + 0.5) * C,
  ]);
  const ec = cellOf(tx, ty);
  if (cost[ei]! > 0 && e[0] === ec[0] && e[1] === ec[1])
    out[out.length - 1] = [tx, ty];
  return out;
}
