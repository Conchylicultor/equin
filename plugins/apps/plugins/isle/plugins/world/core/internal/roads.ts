// An island's potential road network. Every district has a main street running
// east–west through its square (buildings face south, so a street is lined
// along its north side). Trunk roads leave a square along its main street and
// join the next one at the end of its street, so the main streets are the
// trunk roads where they run; the halves no trunk takes are village streets.

import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import {
  arcsOf,
  pointIndex,
  roadCurve,
  spline,
  type PointIndex,
  type Pt,
} from "./geometry";
import { DOCK_ROOT } from "./home";
import { vnoise } from "./noise";
import type { Island, Slot, WorldModel } from "./world-model";

/** Road half-widths as painted, px. */
export const ROAD_R = { trunk: 22, street: 15, spur: 12 } as const;
/** How far a plot's ground band keeps from each kind of road, px. */
export const CLEAR = { trunk: 31, street: 22, spur: 18, square: 18 } as const;

interface Half {
  readonly dir: 1 | -1;
  readonly pts: readonly Pt[];
  readonly len: number;
}

export interface Street {
  readonly pts: readonly Pt[];
  readonly arcs: readonly number[];
}

export interface TrunkEdge {
  readonly id: string;
  /** Node index (0 = the island's root, k = slot k - 1). */
  readonly from: number;
  readonly to: number;
  readonly pts: readonly Pt[];
}

export interface Landing {
  /** The child island this road leads to. */
  readonly island: number;
  readonly at: Pt;
  readonly slotNode: number;
  readonly pts: readonly Pt[];
}

export interface Trunk {
  readonly root: Pt;
  readonly nodes: readonly Pt[];
  /** Each node's parent in the spanning tree (-1 for the root). */
  readonly par: readonly number[];
  readonly edges: readonly TrunkEdge[];
  readonly landings: readonly Landing[];
  /** Every trunk, landing and link road sampled. */
  readonly idx: PointIndex;
  /** Each slot's own streets: its main-street halves no trunk takes. */
  readonly streets: ReadonlyMap<string, readonly Street[]>;
}

/** The two halves (east, west) of a slot's main street, as far as the land and its territory go. */
function mainHalves(M: WorldModel, I: Island, s: Slot): Half[] {
  const r = mulberry32(fnv1a32(`half:${s.id}`));
  const land = (x: number, y: number) => M.height(I, x, y) > 0.17;
  return ([1, -1] as const).map((dir) => {
    const a0 = dir > 0 ? 0 : Math.PI;
    const drift = (r() - 0.5) * 0.02;
    let x = s.x;
    let y = s.y;
    let a = a0 + (r() - 0.5) * 0.2;
    let len = 0;
    const pts: Pt[] = [[x, y]];
    while (len < 780) {
      a += drift + (vnoise(len / 160 + s.k * 7.3 + I.id, a0 * 3) - 0.5) * 0.1;
      a =
        a0 +
        Math.max(
          -0.32,
          Math.min(0.32, Math.atan2(Math.sin(a - a0), Math.cos(a - a0))),
        );
      const nx = x + Math.cos(a) * 30;
      const ny = y + Math.sin(a) * 30;
      if (
        !land(nx, ny) ||
        M.territoryMargin(s, nx, ny) < 50 ||
        (I.home && Math.hypot(nx - DOCK_ROOT[0], ny - DOCK_ROOT[1]) < 230)
      ) {
        break;
      }
      x = nx;
      y = ny;
      len += 30;
      pts.push([x, y]);
    }
    const sp =
      pts.length > 3
        ? spline(
            pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1),
            6,
          )
        : pts;
    return { dir, pts: sp, len };
  });
}

const trunkMemo = new WeakMap<WorldModel, Map<number, Trunk>>();

/** Island I's potential trunk roads: a spanning tree from its root over its slots, plus roads to child landings. */
export function trunkOf(M: WorldModel, I: Island): Trunk {
  let memo = trunkMemo.get(M);
  if (!memo) trunkMemo.set(M, (memo = new Map()));
  const hit = memo.get(I.id);
  if (hit) return hit;
  const P = I.parent !== null ? M.island(I.parent) : null;
  const root: Pt = I.home || !P ? DOCK_ROOT : M.landingOn(I, P.cx, P.cy);
  const nodes: Pt[] = [root, ...I.slots.map((s): Pt => [s.x, s.y])];
  const par = new Array<number>(nodes.length).fill(-1);
  const inT: boolean[] = [true];
  for (let it = 1; it < nodes.length; it++) {
    let bi = -1;
    let bd = Infinity;
    for (let k = 1; k < nodes.length; k++) {
      if (inT[k]) continue;
      for (let j = 0; j < nodes.length; j++) {
        if (!inT[j]) continue;
        const d = Math.hypot(
          nodes[k]![0] - nodes[j]![0],
          nodes[k]![1] - nodes[j]![1],
        );
        if (d < bd) {
          bd = d;
          bi = k;
          par[k] = j;
        }
      }
    }
    let bj = -1;
    let bdd = Infinity;
    for (let j = 0; j < nodes.length; j++) {
      if (!inT[j]) continue;
      const d = Math.hypot(
        nodes[bi]![0] - nodes[j]![0],
        nodes[bi]![1] - nodes[j]![1],
      );
      if (d < bdd) {
        bdd = d;
        bj = j;
      }
    }
    par[bi] = bj;
    inT[bi] = true;
  }
  const halves = I.slots.map((s) => mainHalves(M, I, s));
  const usedHalf = new Set<string>();
  // from node k toward a point: along k's main-street half on that side, as a polyline starting at k
  const leave = (k: number, toward: Pt): readonly Pt[] => {
    if (k === 0) return [nodes[0]!];
    const H = halves[k - 1]!;
    const h = H.find((q) => q.dir === (toward[0] >= nodes[k]![0] ? 1 : -1))!;
    usedHalf.add(`${k}:${h.dir}`);
    return h.pts;
  };
  const join = (ka: number, kb: number, key: string): Pt[] => {
    const A = leave(ka, nodes[kb]!);
    const B = leave(kb, nodes[ka]!);
    const mid = roadCurve(A[A.length - 1]!, B[B.length - 1]!, key);
    return [...A, ...mid.slice(1, -1), ...[...B].reverse()];
  };
  const edges: TrunkEdge[] = [];
  for (let k = 1; k < nodes.length; k++) {
    edges.push({
      id: `tr:${I.id}:${k}`,
      from: par[k]!,
      to: k,
      pts: join(par[k]!, k, `${M.seed}:tr:${I.id}:${k}`),
    });
  }
  const landings: Landing[] = M.islands
    .filter((J) => J.parent === I.id)
    .map((J) => {
      const L = M.landingOn(I, J.cx, J.cy);
      let bk = 1;
      let bd = Infinity;
      I.slots.forEach((s, k) => {
        const d = Math.hypot(s.x - L[0], s.y - L[1]);
        if (d < bd) {
          bd = d;
          bk = k + 1;
        }
      });
      const A = leave(bk, L);
      return {
        island: J.id,
        at: L,
        slotNode: bk,
        pts: [
          ...A,
          ...roadCurve(A[A.length - 1]!, L, `${M.seed}:ld:${J.id}`).slice(1),
        ],
      };
    });
  const streets = new Map(
    I.slots.map((s, i) => [
      s.id,
      halves[i]!.filter(
        (h) => !usedHalf.has(`${i + 1}:${h.dir}`) && h.len > s.r + 150,
      ).map((h) => ({ pts: h.pts, arcs: arcsOf(h.pts) })),
    ]),
  );
  const idx = pointIndex();
  edges.forEach((e) => idx.addLine(e.pts, 10));
  landings.forEach((l) => idx.addLine(l.pts, 10));
  for (const J of M.islands) {
    if (J.parent === null || (J.id !== I.id && J.parent !== I.id)) continue;
    const Pj = M.island(J.parent);
    const la = M.landingOn(J, Pj.cx, Pj.cy);
    const lb = M.landingOn(Pj, J.cx, J.cy);
    if (J.link === "bridge")
      idx.addLine(roadCurve(la, lb, `${M.seed}:br:${J.id}`, 0.08), 10);
    else {
      idx.addLine([la, M.coastOn(J, Pj.cx, Pj.cy)], 10);
      idx.addLine([lb, M.coastOn(Pj, J.cx, J.cy)], 10);
    }
  }
  const T: Trunk = { root, nodes, par, edges, landings, idx, streets };
  memo.set(I.id, T);
  return T;
}
