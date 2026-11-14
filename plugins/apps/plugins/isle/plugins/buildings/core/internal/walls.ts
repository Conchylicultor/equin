// Walls and roofs of a generated building: the wall material fill, the roof
// coverings, and the roof over a rectangular body (with dormers).

import type { Ctx2D } from "../spec";
import { at, jit, type Rnd } from "./colour";
import {
  hline,
  ink,
  planks,
  poly,
  rectPts,
  shingles,
  sketch,
  stones,
  thatch,
  wash,
  type Pt,
} from "./draw";
import type { RoofShape } from "./layout";
import type { Plan, RoofKind, Wall } from "./plan";
import { windowRect } from "./parts";

const WALL_STONE = {
  rubble: { base: "#b2aa98", mortar: "#6c6557" },
  ashlar: { base: "#bfb7a4", mortar: "#7a7262" },
} as const;

/** Fills a wall of `wall` material over the rect, optionally clipped to a path (which it then outlines). */
export function wallFill(
  g: Ctx2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: Rnd,
  wall: Wall,
  clip?: () => void,
): void {
  if (wall === "rubble" || wall === "ashlar") {
    stones(g, x0, y0, x1, y1, r, {
      ...WALL_STONE[wall],
      rowH: wall === "ashlar" ? 11 : 8.5,
      blockW: wall === "ashlar" ? 24 : 15,
      clip,
    });
  } else if (wall === "planks") {
    g.save();
    if (clip) {
      clip();
      g.clip();
    }
    planks(g, x0, y0, x1, y1, r, {
      base: at(["#8a7253", "#7b6549", "#93795a"], (r() * 3) | 0),
      pw: 7,
    });
    g.restore();
  } else if (wall === "logs") {
    g.save();
    if (clip) {
      clip();
      g.clip();
    }
    for (let y = y1; y > y0; y -= 9) {
      wash(
        g,
        () => {
          g.beginPath();
          g.roundRect(x0 - 4, y - 9, x1 - x0 + 8, 9, 4.5);
        },
        [x0 - 4, y - 9, x1 + 4, y],
        jit("#7d6448", r, 14),
        r,
        { blob: 4, stipple: 20, lw: 1 },
      );
      ink(g, 0.6, 0.3);
      hline(g, x0 + 4, y - 4.5, x1 - 4, y - 4.5, r, 0.5);
      g.fillStyle = "#a88c64";
      for (const ex of [x0 - 3, x1 + 3]) {
        g.beginPath();
        g.arc(ex, y - 4.5, 4.2, 0, 7);
        g.fill();
        ink(g, 0.8, 0.7);
        g.stroke();
        g.strokeStyle = "rgba(80,60,40,.5)";
        g.beginPath();
        g.arc(ex, y - 4.5, 2, 0, 7);
        g.stroke();
      }
    }
    g.restore();
  } else {
    // timber frame over plaster, or plain plaster
    wash(
      g,
      clip ??
        (() => {
          g.beginPath();
          g.rect(x0, y0, x1 - x0, y1 - y0);
        }),
      [x0, y0, x1, y1],
      at(["#d8cdb2", "#dcd2bb", "#cfc3a6"], (r() * 3) | 0),
      r,
      { blob: 10, var: 18 },
    );
    if (wall === "timber") {
      const beam = (
        ax: number,
        ay: number,
        bx: number,
        by: number,
        w = 4.5,
      ) => {
        g.save();
        if (clip) {
          clip();
          g.clip();
        }
        g.strokeStyle = "#5a4632";
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
        g.restore();
      };
      beam(x0, y0 + 2, x1, y0 + 2, 5);
      beam(x0, y1 - 2, x1, y1 - 2, 5);
      const n = Math.max(2, Math.round((x1 - x0) / 36));
      for (let i = 0; i <= n; i++) {
        const x = x0 + 2 + ((x1 - x0 - 4) * i) / n;
        beam(x, y0 + 2, x, y1 - 2);
        if (i < n && r() < 0.5) {
          const xn = x0 + 2 + ((x1 - x0 - 4) * (i + 1)) / n;
          if (r() < 0.5) beam(x, y0 + 2, xn, y1 - 2, 3.5);
          else beam(x, y1 - 2, xn, y0 + 2, 3.5);
        }
      }
      if (y1 - y0 > 60) beam(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2, 4);
    }
    if (!clip) sketch(g, rectPts(x0, y0, x1, y1), r, 1.3);
  }
}

/** A roof covering over the polygon `pts`; `eave` (thatch) draws the ragged edge along it. */
export function roofCover(
  g: Ctx2D,
  kind: RoofKind,
  pts: readonly Pt[],
  r: Rnd,
  eave?: readonly [Pt, Pt],
): void {
  switch (kind) {
    case "slate":
      shingles(g, pts, r, { base: "#6d7178", rowH: 6, w: 10, var: 30 });
      break;
    case "tile":
      shingles(g, pts, r, {
        base: "#8e6250",
        rowH: 6,
        w: 8,
        round: true,
        var: 26,
      });
      break;
    case "shingle":
      shingles(g, pts, r, { base: "#76644b", rowH: 6.5, w: 9, var: 34 });
      break;
    case "thatch":
      thatch(g, pts, r, eave);
      break;
  }
}

/** The roof kind small additions (a dormer, a porch, a hood) wear: thatch becomes shingle. */
export const smallRoof = (kind: RoofKind): RoofKind =>
  kind === "thatch" ? "shingle" : kind;

/** Paints the roof of a rectangular body described by `R`. */
export function paintRoof(
  g: Ctx2D,
  R: RoofShape,
  p: Plan,
  r: Rnd,
  night: boolean,
): void {
  const { x0, x1, eaveY, ov, top } = R;
  const cover = (pts: readonly Pt[], eave?: readonly [Pt, Pt]) =>
    roofCover(g, p.roof, pts, r, eave);
  const eave: readonly [Pt, Pt] = [
    [x0 - ov, eaveY + 4],
    [x1 + ov, eaveY + 4],
  ];
  if (R.form === "gablefront") {
    // ridge runs away from us: two slopes seen from above, the gable wall in front
    const { gh, D, ax, ay } = R;
    cover([
      [x0 - ov, eaveY + 6],
      [ax, ay - 6],
      [ax, ay - 6 - D],
      [x0 - ov, eaveY + 6 - D],
    ]);
    cover([
      [ax, ay - 6],
      [x1 + ov, eaveY + 6],
      [x1 + ov, eaveY + 6 - D],
      [ax, ay - 6 - D],
    ]);
    g.fillStyle = "rgba(20,18,15,.22)";
    poly(g, [
      [ax, ay - 6],
      [x1 + ov, eaveY + 6],
      [x1 + ov, eaveY + 6 - D],
      [ax, ay - 6 - D],
    ]);
    g.fill();
    const tri = () =>
      poly(g, [
        [x0, eaveY],
        [ax, ay],
        [x1, eaveY],
      ]);
    wallFill(g, x0, ay, x1, eaveY, r, p.wall, tri);
    tri();
    ink(g, 1.4);
    g.stroke();
    // barge boards
    g.strokeStyle = "#5a4632";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x0 - ov, eaveY + 6);
    g.lineTo(ax, ay - 6);
    g.lineTo(x1 + ov, eaveY + 6);
    g.stroke();
    ink(g, 1);
    g.stroke();
    // a little gable window or vent
    if (r() < 0.6)
      windowRect(g, ax - 7, eaveY - gh * 0.25, 14, 14, r, {
        lit: night,
        arch: true,
      });
    return;
  }
  const { inset } = R;
  if (R.form === "gambrel") {
    // two pitches
    const { kneeY, k } = R;
    cover(
      [
        [x0 - ov, eaveY + 4],
        [x1 + ov, eaveY + 4],
        [x1 - k, kneeY],
        [x0 + k, kneeY],
      ],
      eave,
    );
    cover([
      [x0 + k, kneeY],
      [x1 - k, kneeY],
      [x1 - k - 6, top],
      [x0 + k + 6, top],
    ]);
    g.fillStyle = "rgba(255,248,230,.08)";
    poly(g, [
      [x0 + k, kneeY],
      [x1 - k, kneeY],
      [x1 - k - 6, top],
      [x0 + k + 6, top],
    ]);
    g.fill();
    ink(g, 1.3);
    hline(g, x0 + k, kneeY, x1 - k, kneeY, r);
  } else {
    cover(
      [
        [x0 - ov, eaveY + 4],
        [x1 + ov, eaveY + 4],
        [x1 - inset, top],
        [x0 + inset, top],
      ],
      eave,
    );
    if (R.form !== "gable") {
      // hip lines and the side planes' shading
      g.fillStyle = "rgba(255,248,230,.10)";
      poly(g, [
        [x0 - ov, eaveY + 4],
        [x0 + inset, top],
        [x0 + inset + 10, eaveY + 4],
      ]);
      g.fill();
      g.fillStyle = "rgba(20,18,15,.22)";
      poly(g, [
        [x1 + ov, eaveY + 4],
        [x1 - inset, top],
        [x1 - inset - 10, eaveY + 4],
      ]);
      g.fill();
      ink(g, 1);
      hline(g, x0 - ov + 4, eaveY + 2, x0 + inset, top, r);
      hline(g, x1 + ov - 4, eaveY + 2, x1 - inset, top, r);
    }
  }
  // ridge cap
  const { ra, rb } = R;
  if (p.roof === "thatch") {
    g.fillStyle = "#6f5c34";
    g.beginPath();
    g.roundRect(ra - 2, top - 5, rb - ra + 4, 8, 4);
    g.fill();
    ink(g, 1);
    g.stroke();
    ink(g, 0.8, 0.5);
    for (let x = ra + 6; x < rb - 4; x += 10)
      hline(g, x, top - 4, x + 5, top + 2, r);
  } else {
    g.fillStyle = p.roof === "tile" ? "#7d5444" : "#55585e";
    g.fillRect(ra, top - 4, rb - ra, 5);
    ink(g, 1);
    g.strokeRect(ra, top - 4, rb - ra, 5);
  }
  // dormers on the front slope
  const dw = 20;
  for (const { dx, dy } of R.dormers) {
    wallFill(g, dx - dw / 2, dy - 18, dx + dw / 2, dy, r, "plaster");
    windowRect(g, dx - 6, dy - 2, 12, 12, r, { lit: night });
    roofCover(
      g,
      smallRoof(p.roof),
      [
        [dx - dw / 2 - 4, dy - 16],
        [dx + dw / 2 + 4, dy - 16],
        [dx, dy - 30],
      ],
      r,
    );
  }
}
