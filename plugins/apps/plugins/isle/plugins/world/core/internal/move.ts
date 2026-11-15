// Moving a building by hand: where an app's building may go (back on its own
// plot, a lot it fits, a plot it swaps with a building that fits its own, or a
// new plot made for it wherever it is dropped on a revealed island's land),
// and the placement once it went there. Pure, like placement: a move is validated by the same rules a new app
// is placed by — the plot it leaves is an empty lot like any other, so nothing
// it lands on alone may clash with it.

import { pointIndex } from "./geometry";
import {
  plotBoxes,
  plotById,
  type Placement,
  type Plot,
  type Resident,
} from "./placement";
import {
  groundOK,
  laneHits,
  placed,
  plotCtx,
  sitesOf,
  standAt,
  type Candidate,
  type PlotBoxes,
  type PlotSpot,
  type Site,
} from "./sites";
import type { Island, Slot, WorldModel } from "./world-model";

/** Where a lifted building may be dropped. */
export type MoveTarget =
  /** Back on the plot it stands on: a drop over its own spot reuses it (no move). */
  | { readonly kind: "stay"; readonly plot: Plot }
  /** An existing plot: an empty lot (`other` null), or a swap with the app standing there. */
  | {
      readonly kind: "plot";
      readonly plot: Plot;
      readonly other: string | null;
    }
  /** A new plot made for it where it was dropped (its id the district's next). */
  | { readonly kind: "new"; readonly plot: Plot };

const inside = (a: readonly number[], b: readonly number[]): boolean =>
  a[0]! >= b[0]! - 0.5 &&
  a[1]! >= b[1]! - 0.5 &&
  a[2]! <= b[2]! + 0.5 &&
  a[3]! <= b[3]! + 0.5;

/** Every plot of a placement, in the order they were made. */
function allPlots(placement: Placement): Plot[] {
  return Object.values(placement.plots)
    .flat()
    .sort((a, b) => a.seq - b.seq);
}

/** The plots of `s`'s island that are land (a retired plot is in no one's way). */
const islandPlots = (placement: Placement, s: Slot): Plot[] =>
  s.island.slots
    .flatMap((t) => placement.plots[t.id] ?? [])
    .filter((q) => !q.retired);

/**
 * Can `a` stand on plot `p` (with `skip` refitted for someone else — a swap's
 * other plot — so out of its way)? → its boxes there (sign on either side), or
 * null.
 */
function canTake(
  M: WorldModel,
  placement: Placement,
  p: Plot,
  a: Resident,
  skip: Plot | null,
): PlotBoxes | null {
  const s = M.slotById.get(p.slot);
  if (!s)
    throw new Error(`isle move: plot ${p.id} names unknown slot ${p.slot}`);
  const Sx = sitesOf(M, s.island);
  const others = islandPlots(placement, s).filter(
    (q) => q.id !== p.id && q.id !== skip?.id,
  );
  const ctx = { plots: others, laneIdx: pointIndex() };
  for (const side of [p.side, -p.side as 1 | -1]) {
    const B = plotBoxes(a, side);
    if (inside(B.g, p.g) && inside(B.u, p.u) && inside(B.k, p.k)) return B;
    const q = { ...p, g: B.g, u: B.u, k: B.k };
    if (
      groundOK(M, Sx, s, q, ctx, null, p.lane) === true &&
      !laneHits(p.lane.slice(2), placed(q, q.g), 2)
    )
      return B;
  }
  return null;
}

/** Who stands on each plot among the present residents. */
function standing(
  placement: Placement,
  residents: readonly Resident[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of residents) {
    const pid = placement.occupant[r.id];
    if (pid && !out.has(pid)) out.set(pid, r.id);
  }
  return out;
}

/**
 * The existing plots app `appId`'s building may go to. Empty when it has no
 * plot. Its own plot comes first (`stay`), then every lot it fits and every
 * plot it can swap with. The plot it leaves counts as a lot in the way of
 * every other target but a swap (where the swapped building is refitted onto
 * it). A new plot anywhere else is {@link newPlotAt}'s.
 */
export function moveTargets(
  M: WorldModel,
  placement: Placement,
  residents: readonly Resident[],
  appId: string,
): MoveTarget[] {
  const byId = new Map(residents.map((r) => [r.id, r]));
  const app = byId.get(appId);
  const from = plotById(placement, placement.occupant[appId]);
  if (!app || !from) return [];
  const taken = standing(placement, residents);
  const out: MoveTarget[] = [{ kind: "stay", plot: from }];
  for (const s of M.slots) {
    for (const p of placement.plots[s.id] ?? []) {
      if (p.id === from.id || p.retired) continue;
      const occ = taken.get(p.id) ?? null;
      const other = occ ? byId.get(occ) : undefined;
      if (!canTake(M, placement, p, app, other ? from : null)) continue;
      if (other && !canTake(M, placement, from, other, p)) continue;
      out.push({ kind: "plot", plot: p, other: occ });
    }
  }
  return out;
}

/** The islands shown: home, every island holding a plot, and the islands they grew from. */
function revealedIslands(M: WorldModel, placement: Placement): Island[] {
  const ids = new Set([0]);
  for (const s of M.slots) {
    if (!(placement.plots[s.id] ?? []).some((p) => !p.retired)) continue;
    let I: Island | null = s.island;
    while (I && !ids.has(I.id)) {
      ids.add(I.id);
      I = I.parent !== null ? M.island(I.parent) : null;
    }
  }
  return M.islands.filter((I) => ids.has(I.id));
}

/** How far (world px) from the drop point a new plot's spot may be. */
const DROP_REACH = 180;
/** How far (world px) the plot a drop makes may stand from the drop point. */
const DROP_SNAP = 260;
/** How many spots near the drop point are tried, nearest first. */
const DROP_TRIES = 32;

/**
 * A new plot for app `appId`'s building where it is dropped — door at
 * (`x`, `y`) — on any revealed island's land: the nearest spot (in the
 * district whose land it is, opening that district when it has none yet) where the
 * building stands clear of every plot (the one it leaves included) and its
 * door's lane reaches a road or the square. Null when nothing within reach
 * fits (water, too tight, no way to a road). Pure.
 */
export function newPlotAt(
  M: WorldModel,
  placement: Placement,
  residents: readonly Resident[],
  appId: string,
  x: number,
  y: number,
): Extract<MoveTarget, { kind: "new" }> | null {
  const app = residents.find((r) => r.id === appId);
  if (!app || !placement.occupant[appId]) return null;
  const I = revealedIslands(M, placement).find(
    (J) => J.slots.length && M.height(J, x, y) > 0.1,
  );
  if (!I) return null;
  // the island's spots near the point, whichever district's land they are
  const Sx = sitesOf(M, I);
  const near: { c: Candidate; site: Site; d: number }[] = [];
  for (const site of Sx.sites.values())
    for (const c of site.cands) {
      const d = Math.hypot(c.x - x, (c.y - y) * 1.2);
      if (d < DROP_REACH) near.push({ c, site, d });
    }
  near.sort((a, b) => a.d - b.d);
  const ctx = plotCtx(
    I.slots.flatMap((t) =>
      (placement.plots[t.id] ?? []).filter((q) => !q.retired),
    ),
  );
  // the spot nearest the point (a road-side spot stands back from its road,
  // so not always the nearest candidate's)
  let best: {
    c: Candidate;
    s: Slot;
    B: PlotBoxes;
    spot: PlotSpot;
    d: number;
  } | null = null;
  for (const { c, site } of near.slice(0, DROP_TRIES)) {
    const s = site.s;
    // sign away from the square, else the other side
    const sd: 1 | -1 = c.sx < s.x ? 1 : -1;
    for (const side of [sd, -sd as 1 | -1]) {
      const B = plotBoxes(app, side);
      const spot = standAt(M, Sx, site, ctx, c, B);
      if (typeof spot === "string") continue;
      const d = Math.hypot(spot.x - x, (spot.y - y) * 1.2);
      if (d < DROP_SNAP && (!best || d < best.d)) best = { c, s, B, spot, d };
      break;
    }
  }
  if (!best) return null;
  const { c, s, B, spot } = best;
  const list = placement.plots[s.id] ?? [];
  return {
    kind: "new",
    plot: {
      id: `${s.id}:${list.length}`,
      n: list.length,
      seq: allPlots(placement).length,
      slot: s.id,
      x: spot.x,
      y: spot.y,
      g: B.g,
      u: B.u,
      k: B.k,
      sx: B.sx,
      side: B.side,
      lane: spot.lane,
      ring: spot.ring,
      street: spot.street,
      arc: spot.arc,
      edge: spot.edge,
      landing: spot.landing,
      row: spot.row,
      tags: [
        ...M.terrainTags(I, spot.x, spot.y),
        spot.ring ? "square" : "lane",
      ],
      feat: c.feat,
      category: app.category,
      wild: false,
      retired: false,
    },
  };
}

const withBoxes = (p: Plot, B: PlotBoxes): Plot => ({
  ...p,
  g: B.g,
  u: B.u,
  k: B.k,
  sx: B.sx,
  side: B.side,
  wild: false,
});

/**
 * The placement once `appId`'s building went to `target` (one of
 * `moveTargets`): the plot it lands on fitted to it, the swapped app's
 * building on the plot it left. Pure. Throws when the target no longer fits.
 */
export function applyMove(
  M: WorldModel,
  placement: Placement,
  residents: readonly Resident[],
  appId: string,
  target: MoveTarget,
): Placement {
  const byId = new Map(residents.map((r) => [r.id, r]));
  const app = byId.get(appId);
  const from = plotById(placement, placement.occupant[appId]);
  if (!app || !from)
    throw new Error(`isle move: ${appId} has no plot to move from`);
  if (target.kind === "stay") {
    if (target.plot.id !== from.id)
      throw new Error(
        `isle move: ${appId} no longer stands on ${target.plot.id}`,
      );
    return placement;
  }
  const plots: Record<string, Plot[]> = {};
  for (const [k, l] of Object.entries(placement.plots)) plots[k] = [...l];
  const occupant: Record<string, string> = { ...placement.occupant };
  const put = (p: Plot) => {
    const L = (plots[p.slot] ??= []);
    if (p.n === L.length) L.push(p);
    else if (L[p.n]?.id === p.id) L[p.n] = p;
    else
      throw new Error(`isle move: plot ${p.id} does not follow its district`);
  };
  if (target.kind === "new") {
    put(target.plot);
    occupant[appId] = target.plot.id;
    return { plots, occupant };
  }
  const B = canTake(M, placement, target.plot, app, target.other ? from : null);
  if (!B)
    throw new Error(`isle move: ${appId} no longer fits ${target.plot.id}`);
  put(withBoxes(target.plot, B));
  occupant[appId] = target.plot.id;
  if (target.other) {
    const other = byId.get(target.other);
    if (!other) throw new Error(`isle move: ${target.other} is not present`);
    const B2 = canTake(M, placement, from, other, target.plot);
    if (!B2)
      throw new Error(`isle move: ${target.other} no longer fits ${from.id}`);
    put(withBoxes(from, B2));
    occupant[target.other] = from.id;
  }
  return { plots, occupant };
}

/**
 * The placement once empty lot `plotId` was given back to nature: the plot
 * kept (`wild`), and whoever absent still held it let go — on its return that
 * app is placed anew, like any app without a plot. Pure. Throws when a present
 * resident stands on it (only an empty lot may be restored) or it is unknown.
 */
export function restoreLot(
  placement: Placement,
  residents: readonly Resident[],
  plotId: string,
): Placement {
  const p = plotById(placement, plotId);
  if (!p) throw new Error(`isle restore: no plot ${plotId}`);
  const on = standing(placement, residents).get(p.id);
  if (on) throw new Error(`isle restore: ${on} stands on ${p.id}`);
  const plots: Record<string, Plot[]> = {};
  for (const [k, l] of Object.entries(placement.plots)) plots[k] = [...l];
  plots[p.slot]![p.n] = { ...p, wild: true };
  const occupant: Record<string, string> = {};
  for (const [app, pid] of Object.entries(placement.occupant))
    if (pid !== p.id) occupant[app] = pid;
  return { plots, occupant };
}
