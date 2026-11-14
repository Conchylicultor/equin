// An island's building sites, and whether a building can stand on one.
//
// Each district is a square on a main street (buildings face south, so a
// street is lined along its north side; the south side takes plots that turn
// their back to it, their path going round to the door), then the trunk roads
// through it, the gaps between, and a few outlying spots on the land's
// features (the coast, a cape, a hill top, the river bank, the harbour, a
// wood's edge) reached by a lane.
//
// A plot reserves three boxes, relative to its door: its GROUND band (base,
// props, shadow, signpost: y ≥ -GROUND_BAND) — bands never touch, and no road
// crosses one; its UPPER part (walls, roof…), which may rise in front of the
// ground behind it; and its KEEP (the door and the sign), which nothing in
// front of it may hide.

import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import {
  SETTINGS,
  type Box,
  type Setting,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";
import {
  arcsOf,
  curve,
  pointIndex,
  segDist,
  type PointIndex,
  type Pt,
} from "./geometry";
import { DOCK_ROOT } from "./home";
import { CLEAR, trunkOf, type Street, type Trunk } from "./roads";
import type { Island, Slot, WorldModel } from "./world-model";

/** The boxes a building reserves on its plot, door-relative, its sign on side ±1. */
export interface PlotBoxes {
  /** The ground band. */
  readonly g: Box;
  /** The upper part. */
  readonly u: Box;
  /** The keep (door and sign). */
  readonly k: Box;
  /** The signpost's x, door-relative. */
  readonly sx: number;
  readonly side: 1 | -1;
}

/** Where a plot stands and how its door reaches the road. */
export interface PlotSpot {
  readonly x: number;
  readonly y: number;
  /** The door's path, door first. */
  readonly lane: readonly Pt[];
  /** The path ends on the district square. */
  readonly ring: boolean;
  readonly street: number | null;
  readonly arc: number | null;
  readonly edge: number | null;
  readonly landing: number | null;
  /** The row it lines (road id + side), or null for an outlying spot. */
  readonly row: string | null;
}

/** The box (`g`, `u` or `k`) of a placed plot, in world px. */
export const placed = (p: { x: number; y: number }, b: Box): Box => [
  p.x + b[0],
  p.y + b[1],
  p.x + b[2],
  p.y + b[3],
];
type PlacedPlot = {
  readonly x: number;
  readonly y: number;
  readonly g: Box;
  readonly u: Box;
  readonly k: Box;
};
/** Everything a plot covers, world px. */
export const plotBox = (p: PlacedPlot): Box => {
  const G = placed(p, p.g);
  const U = placed(p, p.u);
  return [Math.min(G[0], U[0]), U[1], Math.max(G[2], U[2]), G[3]];
};
const boxesHit = (a: Box, b: Box, gap = 0) =>
  !(
    a[2] + gap <= b[0] ||
    a[0] >= b[2] + gap ||
    a[3] + gap <= b[1] ||
    a[1] >= b[3] + gap
  );
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * Two plots may stand together: grounds apart, and the one in front (larger y)
 * hides neither the door nor the sign of the one behind, nor most of its body.
 */
export function plotsClash(a: PlacedPlot, b: PlacedPlot, gap = 8): boolean {
  if (Math.abs(a.x - b.x) > 900 || Math.abs(a.y - b.y) > 900) return false;
  if (boxesHit(placed(a, a.g), placed(b, b.g), gap)) return true;
  const [back, front] =
    a.y < b.y || (a.y === b.y && a.x < b.x) ? [a, b] : [b, a];
  const U = placed(front, front.u);
  if (boxesHit(U, placed(back, back.k), 4)) return true;
  const Ub = placed(back, back.u);
  return overlapArea(U, Ub) > 0.3 * (Ub[2] - Ub[0]) * (Ub[3] - Ub[1]);
}

interface Road {
  readonly id: string;
  readonly pts: readonly Pt[];
  readonly arcs: readonly number[];
  readonly kind: "square" | "street" | "trunk";
}
/** What a plot's path joins: a street, a trunk edge, a landing road or the square. */
interface Attach {
  readonly street?: number;
  readonly edge?: number;
  readonly landing?: number;
  readonly square?: boolean;
}
interface NetPoint extends Attach {
  readonly x: number;
  readonly y: number;
  readonly arc?: number;
}
/** A candidate spot: along a road row (`dir`), in a gap, or on a land feature. */
export interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly sx: number;
  readonly sy: number;
  readonly road: Road | null;
  readonly dir: "n" | "s" | "e" | "w" | null;
  readonly attach: Attach | null;
  readonly feat: Setting | null;
  readonly pr: number;
  /** The nearest network points (a gap spot's path targets), filled on first use. */
  near?: readonly NetPoint[];
}

export interface Site {
  readonly s: Slot;
  readonly cands: readonly Candidate[];
  readonly net: readonly NetPoint[];
  readonly streets: readonly Street[];
  /** Candidates no building can use (outside the territory whatever its size). */
  readonly dead: Set<number>;
}

export interface IslandSites {
  readonly I: Island;
  readonly T: Trunk;
  land(x: number, y: number, h?: number): boolean;
  readonly streetIdx: PointIndex;
  readonly sites: ReadonlyMap<string, Site>;
}

const sitesMemo = new WeakMap<WorldModel, Map<number, IslandSites>>();

/** Island I's building sites, per slot (computed once per world). */
export function sitesOf(M: WorldModel, I: Island): IslandSites {
  let memo = sitesMemo.get(M);
  if (!memo) sitesMemo.set(M, (memo = new Map()));
  const hit = memo.get(I.id);
  if (hit) return hit;
  const T = trunkOf(M, I);
  const land = (x: number, y: number, h = 0.1) => M.height(I, x, y) > h;
  const streetIdx = pointIndex(32);
  T.streets.forEach((L) => L.forEach((S) => streetIdx.addLine(S.pts, 8)));
  const sites = new Map<string, Site>();
  for (const s of I.slots) {
    const cands: Candidate[] = [];
    const streets = T.streets.get(s.id) ?? [];
    const own = (x: number, y: number) => M.territoryMargin(s, x, y) > 40;
    // rows: the square's north and south edges and every road out of it
    const alongRoad = (
      pts: readonly Pt[],
      attach: Attach,
      base: number,
      kind: Road["kind"],
      rid: string,
    ) => {
      const road: Road = { id: rid, pts, arcs: arcsOf(pts), kind };
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1]!;
        const [bx, by] = pts[i]!;
        const L = Math.hypot(bx - ax, by - ay) || 1;
        const ux = (bx - ax) / L;
        const uy = (by - ay) / L;
        for (let t = 0; t < L; t += 20) {
          const sx = ax + ux * t;
          const sy = ay + uy * t;
          const d = Math.hypot(sx - s.x, (sy - s.y) * 1.6);
          if ((kind !== "square" && d < s.r + 30) || !own(sx, sy)) continue;
          const pr = base + d;
          const c = (dir: "n" | "s" | "e" | "w", p: number): Candidate => ({
            x: sx,
            y: sy,
            sx,
            sy,
            road,
            dir,
            attach,
            feat: null,
            pr: p,
          });
          if (Math.abs(ux) > 0.5) {
            if (kind !== "square" || sy < s.y) cands.push(c("n", pr));
            if (kind !== "square" || sy > s.y) cands.push(c("s", pr + 150));
          }
          if (Math.abs(uy) > 0.5) {
            cands.push(c("e", pr + 60));
            cands.push(c("w", pr + 60));
          }
        }
      }
    };
    const yT = s.y - s.r / 1.2;
    const yB = s.y + s.r / 1.2;
    for (const dx of [-1, 1]) {
      alongRoad(
        [
          [s.x + dx * 118, yT],
          [s.x + dx * 480, yT],
        ],
        { square: true },
        -60,
        "square",
        `sqT${dx}`,
      );
      alongRoad(
        [
          [s.x + dx * 118, yB],
          [s.x + dx * 480, yB],
        ],
        { square: true },
        40,
        "square",
        `sqB${dx}`,
      );
    }
    streets.forEach((S, i) =>
      alongRoad(S.pts, { street: i }, 0, "street", `st${i}`),
    );
    T.edges.forEach((e, k) =>
      alongRoad(e.pts, { edge: k + 1 }, 0, "trunk", `tr${k}`),
    );
    T.landings.forEach((l) =>
      alongRoad(l.pts, { landing: l.island }, 40, "trunk", `ld${l.island}`),
    );
    // the gaps
    for (let y = s.y - 1000; y <= s.y + 1000; y += 36) {
      for (let x = s.x - 1000; x <= s.x + 1000; x += 36) {
        const d = Math.hypot(x - s.x, (y - s.y) * 1.3);
        if (d > 1000 || !own(x, y) || !land(x, y, 0.14)) continue;
        cands.push({
          x,
          y,
          sx: x,
          sy: y,
          road: null,
          dir: null,
          attach: null,
          feat: null,
          pr: 600 + d,
        });
      }
    }
    // the land's features
    const feats: {
      x: number;
      y: number;
      d: number;
      tags: Set<Setting>;
      e: number;
    }[] = [];
    for (let y = s.y - 1200; y <= s.y + 1200; y += 60) {
      for (let x = s.x - 1300; x <= s.x + 1300; x += 60) {
        if (!own(x, y) || !land(x, y, 0.16)) continue;
        const d = Math.hypot(x - s.x, y - s.y);
        if (d < s.r + 220 || d > 1300) continue;
        const roomy = (
          [
            [-200, -120],
            [200, -120],
            [-200, 70],
            [200, 70],
            [0, 80],
          ] as const
        ).every(([dx, dy]) => land(x + dx, y + dy, 0.12));
        if (!roomy || T.idx.near(x, y, 150)) continue;
        feats.push({
          x,
          y,
          d,
          tags: M.terrainTags(I, x, y),
          e: M.elevation(I, x, y),
        });
      }
    }
    (["coast", "cape", "hill", "shore", "harbour", "forest"] as const).forEach(
      (tag, ti) => {
        const L = feats
          .filter((f) => f.tags.has(tag))
          .sort((a, b) => (tag === "hill" ? b.e - a.e : 0) || a.d - b.d);
        for (let k = 0; k < Math.min(8, L.length); k++) {
          const f = L[k]!;
          cands.push({
            x: f.x,
            y: f.y,
            sx: f.x,
            sy: f.y,
            road: null,
            dir: null,
            attach: null,
            feat: tag,
            pr: 400 + ti * 9 + k * 45,
          });
        }
      },
    );
    cands.sort((a, b) => a.pr - b.pr);
    const net: NetPoint[] = [];
    streets.forEach((S, i) =>
      S.pts.forEach(([x, y], j) =>
        net.push({ x, y, street: i, arc: S.arcs[j]! }),
      ),
    );
    T.edges.forEach((e, k) =>
      e.pts.forEach(([x, y]) => net.push({ x, y, edge: k + 1 })),
    );
    T.landings.forEach((l) =>
      l.pts.forEach(([x, y]) => net.push({ x, y, landing: l.island })),
    );
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      net.push({
        x: s.x + Math.cos(a) * s.r * 0.6,
        y: s.y + Math.sin(a) * s.r * 0.5,
        square: true,
      });
    }
    sites.set(s.id, { s, cands, net, streets, dead: new Set() });
  }
  const out: IslandSites = { I, T, land, streetIdx, sites };
  memo.set(I.id, out);
  return out;
}

const landMemo = new WeakMap<WorldModel, Map<number, Uint8Array>>();
const settingBit = (t: Setting) => 1 << SETTINGS.indexOf(t);

/**
 * How much of island I's district land has one of the settings `want`: how
 * many of its sites' road and gap candidates carry one of the tags (each
 * candidate's tags computed once per world).
 */
export function landWith(
  M: WorldModel,
  I: Island,
  want: readonly Setting[],
): number {
  let memo = landMemo.get(M);
  if (!memo) landMemo.set(M, (memo = new Map()));
  let tags = memo.get(I.id);
  if (!tags) {
    const out: number[] = [];
    for (const site of sitesOf(M, I).sites.values())
      for (const c of site.cands) {
        if (c.feat) continue; // a feature candidate samples its tag, not the land
        let bits = 0;
        for (const t of M.terrainTags(I, c.x, c.y)) bits |= settingBit(t);
        out.push(bits);
      }
    memo.set(I.id, (tags = Uint8Array.from(out)));
  }
  const mask = want.reduce((m, t) => m | settingBit(t), 0);
  let n = 0;
  for (const bits of tags) if (bits & mask) n++;
  return n;
}

const spotsMemo = new WeakMap<WorldModel, Map<string, number>>();

/**
 * How many spots of island I suit a building: the road and land-feature
 * candidates where it can stand on the bare island (boxes `B`, either side,
 * its door's path found) with one of the settings `want` around it. Few spots:
 * a scarce setting, or a building hard to fit there. Memoised per world,
 * island, boxes and settings.
 */
export function spotsFor(
  M: WorldModel,
  I: Island,
  B: readonly [PlotBoxes, PlotBoxes],
  want: readonly Setting[],
): number {
  let memo = spotsMemo.get(M);
  if (!memo) spotsMemo.set(M, (memo = new Map()));
  const key = JSON.stringify([I.id, B[0], B[1], want]);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const Sx = sitesOf(M, I);
  const bare = plotCtx<CtxPlot>([]);
  let n = 0;
  for (const site of Sx.sites.values())
    for (const c of site.cands) {
      if (!c.road && !c.feat) continue;
      for (const b of B) {
        const at = standAt(M, Sx, site, bare, c, b);
        if (typeof at === "string") continue;
        const tags = M.terrainTags(I, at.x, at.y);
        if (want.some((t) => tags.has(t))) n++;
        break;
      }
    }
  memo.set(key, n);
  return n;
}

/** What an island's existing plots occupy: the plots and their lanes. */
export interface PlotCtx<
  P extends PlacedPlot & { lane: readonly Pt[]; ring: boolean },
> {
  readonly plots: P[];
  readonly laneIdx: PointIndex;
}

export function plotCtx<
  P extends PlacedPlot & { lane: readonly Pt[]; ring: boolean },
>(plots: P[]): PlotCtx<P> {
  const laneIdx = pointIndex(32);
  plots.forEach((p) =>
    laneIdx.addLine(p.ring ? p.lane.slice(0, -1) : p.lane, 6),
  );
  return { plots, laneIdx };
}

/** A door's path: down out of its ground band, then on to the target (round the band first when it is behind). */
function spurTo(
  p: PlacedPlot & { slot: string },
  tx: number,
  ty: number,
): Pt[] {
  const yb = p.y + p.g[3] + 14;
  const door: Pt = [p.x, p.y + 6];
  if (ty >= yb - 6) {
    return Math.abs(tx - p.x) < 6
      ? [door, [tx, ty]]
      : [
          door,
          [p.x, yb],
          ...curve(
            p.x,
            yb,
            tx,
            ty,
            fnv1a32(p.slot + p.x) & 1 ? 0.08 : -0.08,
          ).slice(1),
        ];
  }
  const G = placed(p, p.g);
  const cx = tx > p.x ? G[2] + 22 : G[0] - 22;
  return [door, [p.x, yb], [cx, yb], ...curve(cx, yb, tx, ty, 0.05).slice(1)];
}

export function laneHits(lane: readonly Pt[], G: Box, m: number): boolean {
  for (let i = 1; i < lane.length; i++) {
    const [ax, ay] = lane[i - 1]!;
    const [bx, by] = lane[i]!;
    const L = Math.max(1e-6, Math.hypot(bx - ax, by - ay));
    for (let t = 0; t <= L; t += 6) {
      const px = ax + ((bx - ax) * t) / L;
      const py = ay + ((by - ay) * t) / L;
      if (px > G[0] - m && px < G[2] + m && py > G[1] - m && py < G[3] + m)
        return true;
    }
  }
  return false;
}

/** Why a spot was refused (debugging, and `bestSpot`'s dead-candidate bookkeeping). */
export type Refusal =
  | "terr"
  | "clash"
  | "trunk"
  | "street"
  | "lane"
  | "square"
  | "dock"
  | "land"
  | "road"
  | "path";

type CtxPlot = PlacedPlot & {
  lane: readonly Pt[];
  ring: boolean;
  row: string | null;
};

/**
 * The ground a plot p (its boxes placed) needs: inside its district, on land,
 * clear of the other plots (but `except`), of every road (`ownLane` aside) and
 * of the squares and the dock. → true, or why not.
 */
export function groundOK(
  M: WorldModel,
  Sx: IslandSites,
  s: Slot,
  p: PlacedPlot,
  ctx: PlotCtx<CtxPlot>,
  except: CtxPlot | null,
  ownLane: readonly Pt[] | null,
): true | Refusal {
  const { I, T, land, streetIdx } = Sx;
  const G = placed(p, p.g);
  const { x, y } = p;
  if (M.territoryMargin(s, x, y) < 30) return "terr";
  for (const q of ctx.plots)
    if (q !== except && q !== p && plotsClash(p, q)) return "clash";
  const m = CLEAR.trunk;
  if (T.idx.inRect(G[0] - m, G[1] - m, G[2] + m, G[3] + m)) return "trunk";
  if (
    streetIdx.inRect(
      G[0] - CLEAR.street,
      G[1] - CLEAR.street,
      G[2] + CLEAR.street,
      G[3] + CLEAR.street,
    )
  )
    return "street";
  if (ownLane) {
    for (const q of ctx.plots)
      if (
        q !== p &&
        q !== except &&
        q.lane !== ownLane &&
        laneHits(q.lane, G, CLEAR.spur)
      )
        return "lane";
  } else if (
    ctx.laneIdx.inRect(
      G[0] - CLEAR.spur,
      G[1] - CLEAR.spur,
      G[2] + CLEAR.spur,
      G[3] + CLEAR.spur,
    )
  )
    return "lane";
  const sqHit = I.slots.some((t) => {
    const cx = Math.max(G[0], Math.min(G[2], t.x));
    const cy = Math.max(G[1], Math.min(G[3], t.y));
    return Math.hypot(cx - t.x, (cy - t.y) * 1.2) < t.r + 18;
  });
  if (sqHit) return "square";
  if (
    I.home &&
    Math.hypot(
      Math.max(G[0], Math.min(G[2], DOCK_ROOT[0])) - DOCK_ROOT[0],
      Math.max(G[1], Math.min(G[3], DOCK_ROOT[1])) - DOCK_ROOT[1],
    ) < 150
  ) {
    return "dock";
  }
  const probes: readonly Pt[] = [
    [G[0], G[1]],
    [G[2], G[1]],
    [G[0], G[3]],
    [G[2], G[3]],
    [x, G[1]],
    [x, G[3]],
    [(G[0] + x) / 2, y],
    [(G[2] + x) / 2, y],
    [x, G[3] + 16],
  ];
  if (!probes.every(([px, py]) => land(px, py))) return "land";
  return true;
}

/**
 * Where a building (boxes B) would stand at candidate c of a site, if its
 * ground is free there (`groundOK`) — its door's path not looked for. → its
 * position, or why not.
 */
export function groundAt(
  M: WorldModel,
  Sx: IslandSites,
  site: Site,
  ctx: PlotCtx<CtxPlot>,
  c: Candidate,
  B: PlotBoxes,
): Pt | Refusal {
  const s = site.s;
  let x = c.x;
  let y = c.y;
  const rd = c.road;
  if (c.dir && rd) {
    // clear of the road along the whole band, not just at the candidate point
    const cl = CLEAR[rd.kind] + 3;
    const P = rd.pts;
    if (c.dir === "n" || c.dir === "s") {
      let m = c.dir === "n" ? Infinity : -Infinity;
      x = c.sx;
      for (const [px, py] of P)
        if (px > x + B.g[0] - 30 && px < x + B.g[2] + 30)
          m = c.dir === "n" ? Math.min(m, py) : Math.max(m, py);
      y = c.dir === "n" ? m - B.g[3] - cl : m - B.g[1] + cl;
    } else {
      let m = c.dir === "e" ? -Infinity : Infinity;
      y = c.sy + 10;
      for (const [px, py] of P)
        if (py > y + B.g[1] - 30 && py < y + B.g[3] + 30)
          m = c.dir === "e" ? Math.max(m, px) : Math.min(m, px);
      x = c.dir === "e" ? m - B.g[0] + cl : m - B.g[2] - cl;
    }
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "road";
  const ok = groundOK(
    M,
    Sx,
    s,
    { x, y, g: B.g, u: B.u, k: B.k },
    ctx,
    null,
    null,
  );
  return ok === true ? [x, y] : ok;
}

/** Can a building (boxes B) stand at candidate c of a site, among the island's plots? → a spot, or why not. */
export function standAt(
  M: WorldModel,
  Sx: IslandSites,
  site: Site,
  ctx: PlotCtx<CtxPlot>,
  c: Candidate,
  B: PlotBoxes,
): PlotSpot | Refusal {
  const s = site.s;
  const rd = c.road;
  const at0 = groundAt(M, Sx, site, ctx, c, B);
  if (typeof at0 === "string") return at0;
  const [x, y] = at0;
  const p = { x, y, g: B.g, u: B.u, k: B.k, slot: s.id };
  const G = placed(p, p.g);
  // the door's path
  const near: Box[] = [];
  for (const q of ctx.plots)
    if (Math.abs(q.x - x) < 1300 && Math.abs(q.y - y) < 1300)
      near.push(placed(q, q.g));
  const pathOK = (path: readonly Pt[]) => {
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1]!;
      const [bx, by] = path[i]!;
      const L = Math.max(1e-6, Math.hypot(bx - ax, by - ay));
      const sx0 = Math.min(ax, bx) - 17;
      const sx1 = Math.max(ax, bx) + 17;
      const sy0 = Math.min(ay, by) - 17;
      const sy1 = Math.max(ay, by) + 17;
      const seg: Box[] = [];
      for (const Q of near)
        if (Q[0] < sx1 && Q[2] > sx0 && Q[1] < sy1 && Q[3] > sy0) seg.push(Q);
      for (let t = 0, k = 0; t <= L; t += 6, k++) {
        const px = ax + ((bx - ax) * t) / L;
        const py = ay + ((by - ay) * t) / L;
        if (
          px > G[0] - 16 &&
          px < G[2] + 16 &&
          py > G[1] - 16 &&
          py < G[3] + 16 &&
          !(Math.abs(px - x) < 18 && py >= y)
        )
          return false;
        for (const Q of seg)
          if (
            px > Q[0] - 16 &&
            px < Q[2] + 16 &&
            py > Q[1] - 16 &&
            py < Q[3] + 16
          )
            return false;
        if (k % 2 === 0 && !Sx.land(px, py, 0.08)) return false;
      }
    }
    return true;
  };
  let lane: Pt[] | null = null;
  let target: NetPoint | null = null;
  const tryTo = (n: NetPoint) => {
    const path = spurTo(p, n.x, n.y);
    if (pathOK(path)) {
      lane = path;
      target = n;
      return true;
    }
    return false;
  };
  const at = (qx: number, qy: number): NetPoint => {
    const r = rd!;
    const q = segDist(r.pts, qx, qy);
    return {
      x: q.x,
      y: q.y,
      ...c.attach,
      arc:
        r.arcs[q.i - 1]! +
        Math.hypot(q.x - r.pts[q.i - 1]![0], q.y - r.pts[q.i - 1]![1]),
    };
  };
  if (c.dir === "n") tryTo(at(x, y + B.g[3] + 10));
  else if (c.dir === "s") {
    const tw = s.x > x ? [G[2] + 24, G[0] - 24] : [G[0] - 24, G[2] + 24];
    tw.some((qx) => tryTo(at(qx, y + B.g[1])));
  } else if (c.dir) tryTo(at(x, y + B.g[3] + 14));
  else {
    if (!c.near) {
      const L: { n: NetPoint; d: number }[] = [];
      for (let k = 0; k < site.net.length; k += 2) {
        const n = site.net[k]!;
        const dx = n.x - x;
        const dy = n.y - y - 40;
        if (Math.abs(dx) < 900 && Math.abs(dy) < 900)
          L.push({ n, d: Math.hypot(dx, dy) });
      }
      c.near = L.sort((a, b) => a.d - b.d)
        .filter((_, k) => k < 8 || k % 5 === 0)
        .slice(0, 20)
        .map((e) => e.n);
    }
    for (const n of c.near) if (tryTo(n)) break;
  }
  const found = lane as Pt[] | null;
  const tgt = target as NetPoint | null;
  if (!found || !tgt) return "path";
  const finalLane: Pt[] = tgt.square ? [...found, [s.x, s.y]] : found;
  return {
    x,
    y,
    lane: finalLane,
    ring: !!tgt.square,
    street: tgt.street ?? null,
    arc: tgt.arc ?? null,
    edge: tgt.edge ?? null,
    landing: tgt.landing ?? null,
    row: c.road ? c.road.id + c.dir : null,
  };
}

export interface BestSpot {
  readonly spot: PlotSpot;
  readonly side: 1 | -1;
  readonly tags: readonly Setting[];
  readonly c: Candidate;
  /** How well it suits the building's setting ({@link tagScore}): 10 first choice, clean. */
  readonly m: number;
  readonly score: number;
}

/** No settings: nothing for a building to leave for the others. */
export const NO_SETTINGS: ReadonlySet<Setting> = new Set();

/** What standing on a spot of a setting another building still waits for costs. */
const SPARE_COST = 4;

/**
 * How well a spot's tags suit a building's preferred settings: 10 its first
 * choice, 6 its second, 0 neither — less {@link SPARE_COST} when the spot also
 * has a setting in `spare` (one the buildings still to come want and this one
 * does not), so a building takes the spot only it can use before one another
 * needs.
 */
export const tagScore = (
  pref: readonly Setting[],
  tags: readonly Setting[],
  spare: ReadonlySet<Setting> = NO_SETTINGS,
): number =>
  (pref[0] && tags.includes(pref[0])
    ? 10
    : pref[1] && tags.includes(pref[1])
      ? 6
      : 0) -
  (tags.some((t) => spare.has(t) && !pref.includes(t)) ? SPARE_COST : 0);

/**
 * The best spot of a site for a building: the first free spots in the site's
 * order, the one that suits its setting winning. `boxes(side)` gives the
 * building's boxes with its sign on that side; `spare`, the settings to leave
 * for the buildings still to come ({@link tagScore}).
 */
export function bestSpot(
  M: WorldModel,
  Sx: IslandSites,
  site: Site,
  ctx: PlotCtx<CtxPlot>,
  boxes: (side: 1 | -1) => PlotBoxes,
  pref: readonly Setting[],
  spare: ReadonlySet<Setting> = NO_SETTINGS,
): BestSpot | null {
  let best: BestSpot | null = null;
  let seen = 0;
  const tagsAt = (spot: PlotSpot): Setting[] => [
    ...M.terrainTags(Sx.I, spot.x, spot.y),
    spot.ring ? "square" : "lane",
  ];
  const tryCand = (i: number): Omit<BestSpot, "score"> | null => {
    const c = site.cands[i]!;
    // along a row, stand back to back with the nearest neighbour (signs outward), else face the square
    let sd: 1 | -1 = c.sx < site.s.x ? 1 : -1;
    if ((c.dir === "n" || c.dir === "s") && c.road) {
      let nb: CtxPlot | null = null;
      let nd = 700;
      for (const q of ctx.plots) {
        if (q.row === c.road.id + c.dir && Math.abs(q.x - c.sx) < nd) {
          nd = Math.abs(q.x - c.sx);
          nb = q;
        }
      }
      if (nb) sd = c.sx > nb.x ? 1 : -1;
    }
    let got: PlotSpot | null = null;
    let side: 1 | -1 = sd;
    let hard = 0;
    for (const sv of [sd, -sd as 1 | -1]) {
      const r = standAt(M, Sx, site, ctx, c, boxes(sv));
      if (typeof r !== "string") {
        got = r;
        side = sv;
        break;
      }
      if (r === "terr") hard++;
    }
    if (!got) {
      if (hard === 2 && !c.dir) site.dead.add(i);
      return null;
    }
    const tags = tagsAt(got);
    return { spot: got, side, tags, c, m: tagScore(pref, tags, spare) };
  };
  // the outlying spots on the features it likes, then the first free spots in the site's order
  const liked = (c: Candidate) =>
    c.feat
      ? pref.includes(c.feat)
      : pref.includes("square") && !!c.attach?.square;
  for (let i = 0, k = 0; i < site.cands.length; i++) {
    const c = site.cands[i]!;
    if (site.dead.has(i) || !liked(c)) continue;
    const r = tryCand(i);
    if (!r) continue;
    const score = r.m - (c.feat ? 1.5 : 0.5) - k++ * 0.1;
    if (!best || score > best.score) best = { ...r, score };
    if (r.m === 10) break;
  }
  // a few free spots in order; further, while none suits it, as long as the street goes on
  for (
    let i = 0;
    i < site.cands.length &&
    seen < (pref.length && (!best || best.m < 10) ? 14 : 6);
    i++
  ) {
    const c = site.cands[i]!;
    if (c.feat || site.dead.has(i)) continue;
    const r = tryCand(i);
    if (!r) continue;
    seen++;
    const score = r.m - seen * 0.25;
    if (!best || score > best.score) best = { ...r, score };
    if (r.m === 10) break;
  }
  return best;
}
