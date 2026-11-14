// The stored plots ↔ world/core's Placement, both ways, exactly: rows are the
// placement's plots (one each, keyed by plot id), their `occupant` the inverse
// of `placement.occupant`. And the writes that take one placement to the next.

import type {
  Placement,
  Plot,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import {
  APP_CATEGORIES,
  type AppCategory,
} from "@plugins/primitives/plugins/pane/core";
import type { PlotWrite } from "./endpoints";
import type { IslePlotRow, PlotGeometry } from "./schemas";

function categoryOf(row: IslePlotRow): AppCategory {
  const c = APP_CATEGORIES.find((k) => k === row.category);
  if (!c)
    throw new Error(
      `isle plots: plot ${row.plotId} has unknown category "${row.category}"`,
    );
  return c;
}

/** A stored row as world/core's Plot. */
export function plotOfRow(row: IslePlotRow): Plot {
  return {
    ...row.geometry,
    id: row.plotId,
    n: row.n,
    seq: row.seq,
    slot: row.slot,
    category: categoryOf(row),
  };
}

/** A Plot's geometry column (everything but its identity columns). */
export function geometryOf(p: Plot): PlotGeometry {
  return {
    x: p.x,
    y: p.y,
    g: p.g,
    u: p.u,
    k: p.k,
    sx: p.sx,
    side: p.side,
    lane: p.lane,
    ring: p.ring,
    street: p.street,
    arc: p.arc,
    edge: p.edge,
    landing: p.landing,
    row: p.row,
    tags: p.tags,
    feat: p.feat,
  };
}

/**
 * The placement the stored rows hold. Throws on rows that do not form one
 * (a district's plots not numbered 0…n-1, an app on two plots): the table is
 * written only by `claim` / `move`, so that is a bug, never data to absorb.
 */
export function placementOfRows(rows: readonly IslePlotRow[]): Placement {
  const plots: Record<string, Plot[]> = {};
  const occupant: Record<string, string> = {};
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const p = plotOfRow(row);
    (plots[p.slot] ??= []).push(p);
    if (row.occupant !== null) {
      if (occupant[row.occupant])
        throw new Error(`isle plots: ${row.occupant} stands on two plots`);
      occupant[row.occupant] = p.id;
    }
  }
  for (const [slot, list] of Object.entries(plots)) {
    list.sort((a, b) => a.n - b.n);
    list.forEach((p, i) => {
      if (p.n !== i || p.id !== `${slot}:${i}`)
        throw new Error(
          `isle plots: district ${slot} is missing plot ${slot}:${i}`,
        );
    });
  }
  return { plots, occupant };
}

/**
 * Who stands on each plot: the inverse of `occupant`. An app the placement
 * still maps to a plot another app has since taken (it was absent then) loses
 * it: one occupant per plot, the one that came to it last in `next`.
 */
function occupants(
  before: Placement,
  next: Placement,
): { before: Map<string, string>; next: Map<string, string> } {
  const inv = (pl: Placement, prefer: Placement | null) => {
    const m = new Map<string, string>();
    for (const [app, pid] of Object.entries(pl.occupant)) {
      const had = m.get(pid);
      const fresh = prefer !== null && prefer.occupant[app] !== pid;
      if (had === undefined || fresh) m.set(pid, app);
    }
    return m;
  };
  return { before: inv(before, null), next: inv(next, before) };
}

const sameGeometry = (a: Plot, b: Plot) =>
  JSON.stringify(geometryOf(a)) === JSON.stringify(geometryOf(b));

/**
 * The writes taking `before` (what was read) to `next` (placeResidents' or
 * applyMove's answer): every new plot (expected absent), and every plot whose
 * occupant or geometry changed (expected to hold the occupant read).
 */
export function placementWrites(
  before: Placement,
  next: Placement,
): PlotWrite[] {
  const occ = occupants(before, next);
  const out: PlotWrite[] = [];
  for (const list of Object.values(next.plots)) {
    for (const p of list) {
      const old = before.plots[p.slot]?.[p.n];
      const occupant = occ.next.get(p.id) ?? null;
      if (!old) {
        out.push({ plot: p, occupant, expect: { kind: "absent" } });
        continue;
      }
      const was = occ.before.get(p.id) ?? null;
      if (was !== occupant || !sameGeometry(old, p))
        out.push({
          plot: p,
          occupant,
          expect: { kind: "occupant", appId: was },
        });
    }
  }
  return out.sort((a, b) => a.plot.seq - b.plot.seq);
}
