// Moving a building by hand: where an app's building may go (a lot it fits, a
// plot it swaps with a building that fits its own, or a new plot made for it
// in any open district), and the placement once it went there. Pure, like
// placement: a move is validated by the same rules a new app is placed by.

import { pointIndex } from "./geometry";
import {
  plotBoxes,
  plotById,
  type Placement,
  type Plot,
  type Resident,
} from "./placement";
import {
  bestSpot,
  groundOK,
  laneHits,
  placed,
  plotCtx,
  sitesOf,
  type PlotBoxes,
} from "./sites";
import type { WorldModel } from "./world-model";

/** Where a lifted building may be dropped. */
export type MoveTarget =
  /** An existing plot: an empty lot (`other` null), or a swap with the app standing there. */
  | {
      readonly kind: "plot";
      readonly plot: Plot;
      readonly other: string | null;
    }
  /** A new plot made for it in an open district (its id the district's next). */
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

/**
 * Can `a` stand on plot `p` (leaving `skip`, the plot it moves from)? → its
 * boxes there (sign on either side), or null.
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
  const others = s.island.slots
    .flatMap((t) => placement.plots[t.id] ?? [])
    .filter((q) => q.id !== p.id && q.id !== skip?.id);
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

/** Where app `appId`'s building may go. Empty when it has no plot. */
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
  const out: MoveTarget[] = [];
  const total = allPlots(placement).length;
  for (const s of M.slots) {
    const list = placement.plots[s.id];
    if (!list?.length) continue;
    for (const p of list) {
      if (p.id === from.id) continue;
      const occ = taken.get(p.id) ?? null;
      const other = occ ? byId.get(occ) : undefined;
      if (!canTake(M, placement, p, app, from)) continue;
      if (other && !canTake(M, placement, from, other, p)) continue;
      out.push({ kind: "plot", plot: p, other: occ });
    }
    const Sx = sitesOf(M, s.island);
    const others = s.island.slots
      .flatMap((t) => placement.plots[t.id] ?? [])
      .filter((q) => q.id !== from.id);
    const sp = bestSpot(
      M,
      Sx,
      Sx.sites.get(s.id)!,
      plotCtx(others.map((q) => ({ ...q }))),
      (side) => plotBoxes(app, side),
      app.setting,
    );
    if (!sp) continue;
    const B = plotBoxes(app, sp.side);
    out.push({
      kind: "new",
      plot: {
        id: `${s.id}:${list.length}`,
        n: list.length,
        seq: total,
        slot: s.id,
        x: sp.spot.x,
        y: sp.spot.y,
        g: B.g,
        u: B.u,
        k: B.k,
        sx: B.sx,
        side: B.side,
        lane: sp.spot.lane,
        ring: sp.spot.ring,
        street: sp.spot.street,
        arc: sp.spot.arc,
        edge: sp.spot.edge,
        landing: sp.spot.landing,
        row: sp.spot.row,
        tags: sp.tags,
        feat: sp.c.feat,
        category: app.category,
      },
    });
  }
  return out;
}

const withBoxes = (p: Plot, B: PlotBoxes): Plot => ({
  ...p,
  g: B.g,
  u: B.u,
  k: B.k,
  sx: B.sx,
  side: B.side,
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
  const B = canTake(M, placement, target.plot, app, from);
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
