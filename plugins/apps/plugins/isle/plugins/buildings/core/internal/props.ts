// The category props: what stands beside a generated building, by the kind of
// app it houses (a cart for work, an easel for create, a bench and lute for
// music…). `paintProps` draws the set for a category around the side anchor
// `x`; the footprint declares the same set's extents in `footprint.ts`.

import type { AppCategory } from "@plugins/primitives/plugins/pane/core";
import type { Ctx2D } from "../spec";
import { at, dark, accent, type Rnd } from "./colour";
import { bbox, castShadow, hline, ink, planks, poly, wash } from "./draw";
import { barrel, bench, crate, lantern, sack } from "./parts";

/** A lute leaning at (x, y). */
export function lute(g: Ctx2D, x: number, y: number, r: Rnd): void {
  g.save();
  g.translate(x, y);
  g.rotate(-0.5);
  wash(
    g,
    () => {
      g.beginPath();
      g.ellipse(0, 0, 7, 9, 0, 0, 7);
    },
    [-7, -9, 7, 9],
    "#a0703e",
    r,
    { blob: 3, stipple: 6, lw: 1 },
  );
  g.fillStyle = "#2a2018";
  g.beginPath();
  g.arc(0, -2, 2.4, 0, 7);
  g.fill();
  g.fillStyle = "#5a4030";
  g.fillRect(-1.5, -24, 3, 16);
  ink(g, 0.8);
  g.strokeRect(-1.5, -24, 3, 16);
  g.restore();
}

/** A two-wheeled hand cart at (x, y). */
export function cart(g: Ctx2D, x: number, y: number, r: Rnd): void {
  castShadow(
    g,
    [
      [x - 18, y],
      [x + 22, y],
      [x + 30, y + 5],
      [x - 10, y + 5],
    ],
    0.28,
  );
  planks(g, x - 20, y - 18, x + 18, y - 9, r, {
    base: "#8a7253",
    vertical: false,
    pw: 4.5,
  });
  g.strokeStyle = "#5a4632";
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(x + 18, y - 12);
  g.lineTo(x + 34, y - 4);
  g.stroke();
  for (const wx of [x - 10, x + 8]) {
    g.fillStyle = "#6e5a46";
    g.beginPath();
    g.arc(wx, y - 6, 6.5, 0, 7);
    g.fill();
    ink(g, 1.1);
    g.stroke();
    g.strokeStyle = "#4a3a2a";
    g.lineWidth = 1;
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      g.moveTo(wx, y - 6);
      g.lineTo(wx + Math.cos(k * 0.8) * 6, y - 6 + Math.sin(k * 0.8) * 6);
      g.stroke();
    }
  }
}

/** A rack of garden tools against the wall at (x, y). */
export function toolRack(g: Ctx2D, x: number, y: number): void {
  g.fillStyle = "#5a4632";
  g.fillRect(x - 12, y - 28, 24, 3);
  g.fillRect(x - 12, y - 28, 2.5, 28);
  g.fillRect(x + 9.5, y - 28, 2.5, 28);
  for (const [dx, k] of [
    [-7, "rake"],
    [-1, "spade"],
    [5, "pick"],
  ] as const) {
    g.strokeStyle = "#6e5a46";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + dx, y - 32);
    g.lineTo(x + dx + 2, y - 2);
    g.stroke();
    g.fillStyle = "#5c5a58";
    if (k === "spade") g.fillRect(x + dx - 2, y - 8, 6, 7);
    else if (k === "rake") g.fillRect(x + dx - 4, y - 34, 9, 2);
    else {
      g.beginPath();
      g.moveTo(x + dx - 5, y - 30);
      g.quadraticCurveTo(x + dx, y - 36, x + dx + 6, y - 30);
      g.lineWidth = 2;
      g.strokeStyle = "#5c5a58";
      g.stroke();
    }
  }
  ink(g, 0.8, 0.5);
  g.strokeRect(x - 12, y - 28, 24, 3);
}

/** A painter's easel at (x, y), a canvas in the app's accent `A`. */
export function easel(g: Ctx2D, x: number, y: number, r: Rnd, A: string): void {
  castShadow(
    g,
    [
      [x - 10, y],
      [x + 12, y],
      [x + 18, y + 4],
      [x - 4, y + 4],
    ],
    0.22,
  );
  g.strokeStyle = "#6e5a46";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x - 9, y);
  g.lineTo(x, y - 40);
  g.lineTo(x + 9, y);
  g.moveTo(x, y - 40);
  g.lineTo(x + 2, y + 2);
  g.stroke();
  wash(
    g,
    () => {
      g.beginPath();
      g.rect(x - 11, y - 36, 22, 18);
    },
    [x - 11, y - 36, x + 11, y - 18],
    "#e6dcc2",
    r,
    { blob: 3, stipple: 8 },
  );
  g.fillStyle = dark(A, 0.05, 0.6);
  g.beginPath();
  g.ellipse(x - 3, y - 26, 5, 3, 0.3, 0, 7);
  g.fill();
  g.fillStyle = "rgba(90,110,60,.6)";
  g.fillRect(x - 10, y - 22, 20, 3);
  g.fillStyle = "#5a4632";
  g.fillRect(x - 12, y - 18, 24, 2);
}

/** A drafting table at (x, y). */
export function draftingTable(g: Ctx2D, x: number, y: number, r: Rnd): void {
  castShadow(
    g,
    [
      [x - 14, y],
      [x + 16, y],
      [x + 22, y + 4],
      [x - 8, y + 4],
    ],
    0.22,
  );
  g.fillStyle = "#5a4632";
  g.fillRect(x - 12, y - 16, 2.5, 16);
  g.fillRect(x + 10, y - 16, 2.5, 16);
  const top = [
    [x - 16, y - 16],
    [x + 16, y - 16],
    [x + 12, y - 26],
    [x - 12, y - 26],
  ] as const;
  wash(g, () => poly(g, top), bbox(top), "#8a7253", r, {
    blob: 3,
    stipple: 6,
    lw: 1,
  });
  const pap = [
    [x - 10, y - 18],
    [x + 8, y - 18],
    [x + 6, y - 24],
    [x - 8, y - 24],
  ] as const;
  wash(g, () => poly(g, pap), bbox(pap), "#cfd8dc", r, {
    blob: 2,
    stipple: 4,
    lw: 0.6,
  });
  ink(g, 0.5, 0.5);
  hline(g, x - 6, y - 21, x + 4, y - 21, r);
  hline(g, x - 4, y - 19.5, x + 2, y - 22.5, r);
}

/** A post box at (x, y). */
export function mailbox(g: Ctx2D, x: number, y: number, r: Rnd): void {
  castShadow(
    g,
    [
      [x - 4, y],
      [x + 4, y],
      [x + 10, y + 3],
      [x + 2, y + 3],
    ],
    0.3,
  );
  g.fillStyle = "#5a4632";
  g.fillRect(x - 1.5, y - 22, 3, 22);
  wash(
    g,
    () => {
      g.beginPath();
      g.moveTo(x - 8, y - 20);
      g.lineTo(x - 8, y - 28);
      g.quadraticCurveTo(x, y - 34, x + 8, y - 28);
      g.lineTo(x + 8, y - 20);
      g.closePath();
    },
    [x - 8, y - 34, x + 8, y - 20],
    accent("#9a4a3a"),
    r,
    { blob: 3, stipple: 6 },
  );
  g.fillStyle = "#3a332c";
  g.fillRect(x + 6, y - 32, 1.5, 8);
  g.fillStyle = "#8e4434";
  g.fillRect(x + 7, y - 32, 4, 3);
}

const FLOWER_COLOURS = [
  "#7a8a48",
  "#5f6e37",
  "#b9895a",
  "#c9b27a",
  "#a0726a",
] as const;

/** A window flower box `w` wide at (x, y). */
export function flowerBox(
  g: Ctx2D,
  x: number,
  y: number,
  w: number,
  r: Rnd,
): void {
  planks(g, x, y, x + w, y + 6, r, { base: "#6e5a46", vertical: false, pw: 6 });
  for (let k = 0; k < w / 3; k++) {
    g.fillStyle = at(FLOWER_COLOURS, (r() * 5) | 0);
    g.beginPath();
    g.arc(x + 1 + k * 3.2, y + 1 - r() * 3, 2 + r(), 0, 7);
    g.fill();
  }
}

/** A swing frame (without the swinging seat — that is animated) at (x, y). */
export function swingFrame(g: Ctx2D, x: number, y: number): void {
  castShadow(
    g,
    [
      [x - 18, y],
      [x + 18, y],
      [x + 26, y + 5],
      [x - 10, y + 5],
    ],
    0.2,
  );
  g.strokeStyle = "#6e5a46";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(x - 20, y);
  g.lineTo(x - 14, y - 40);
  g.lineTo(x - 8, y);
  g.moveTo(x + 8, y);
  g.lineTo(x + 14, y - 40);
  g.lineTo(x + 20, y);
  g.stroke();
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(x - 16, y - 40);
  g.lineTo(x + 16, y - 40);
  g.stroke();
  ink(g, 0.9, 0.6);
  g.beginPath();
  g.moveTo(x - 16, y - 40);
  g.lineTo(x + 16, y - 40);
  g.stroke();
}

/** A cog of radius `R` at (x, y). */
export function gear(g: Ctx2D, x: number, y: number, R: number, r: Rnd): void {
  const n = Math.round(R * 0.8);
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const rr = i % 2 ? R : R * 0.8;
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.92]);
  }
  wash(g, () => poly(g, pts), [x - R, y - R, x + R, y + R], "#7d7466", r, {
    blob: 3,
    stipple: 10,
    lw: 1.1,
  });
  g.fillStyle = "#4a443c";
  g.beginPath();
  g.arc(x, y, R * 0.28, 0, 7);
  g.fill();
  ink(g, 0.9);
  g.stroke();
}

/** A ladder `h` tall leaning from (x, y). */
export function ladder(g: Ctx2D, x: number, y: number, h: number): void {
  g.strokeStyle = "#7b6549";
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + 8, y - h);
  g.moveTo(x + 10, y);
  g.lineTo(x + 18, y - h);
  g.stroke();
  g.lineWidth = 1.8;
  for (let k = 6; k < h; k += 8) {
    const t = k / h;
    g.beginPath();
    g.moveTo(x + t * 8, y - k);
    g.lineTo(x + 10 + t * 8, y - k);
    g.stroke();
  }
  ink(g, 0.7, 0.5);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + 8, y - h);
  g.stroke();
}

/** A water butt at (x, y), with a downpipe. */
export function waterButt(g: Ctx2D, x: number, y: number, r: Rnd): void {
  barrel(g, x, y, 9, r);
  g.fillStyle = "#3e4a52";
  g.beginPath();
  g.ellipse(x, y - 20.7, 7, 2.6, 0, 0, 7);
  g.fill();
  g.strokeStyle = "#4a4640";
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(x + 3, y - 21);
  g.lineTo(x + 3, y - 56);
  g.stroke();
}

/** What `paintProps` needs to know of the plan. */
export interface PropsPlan {
  readonly cat: AppCategory;
  /** The side the props go on (-1 left, 1 right). */
  readonly side: -1 | 1;
  readonly maxW: number;
}

/**
 * The props of a category around the side anchor `x` (outside the wall); they
 * sit around y 0..34.
 */
export function paintProps(
  g: Ctx2D,
  p: PropsPlan,
  x: number,
  r: Rnd,
  A: string,
  night: boolean,
): void {
  const s = p.side;
  const X = (d: number) => x + s * d;
  switch (p.cat) {
    case "work":
      crate(g, X(4), 18, 13, r);
      crate(g, X(16), 22, 11, r);
      if (p.maxW > 160) cart(g, X(26), 32, r);
      else toolRack(g, X(6), 2);
      barrel(g, X(-2), 34, 7, r);
      break;
    case "create":
      if (r() < 0.5) easel(g, X(10), 24, r, A);
      else draftingTable(g, X(12), 24, r);
      crate(g, X(-4), 34, 9, r);
      break;
    case "music":
      bench(g, X(-6) - (s < 0 ? 34 : 0), 26, 34, r);
      lute(g, X(10), 12, r);
      lantern(g, X(-12), -46, night);
      break;
    case "life":
      bench(g, X(-4) - (s < 0 ? 32 : 0), 28, 32, r);
      mailbox(g, X(26), 30, r);
      break;
    case "data":
      barrel(g, X(4), 20, 8, r);
      barrel(g, X(20), 24, 8, r);
      sack(g, X(8), 34, 8, r);
      sack(g, X(-6), 30, 7, r);
      crate(g, X(28), 34, 10, r);
      break;
    case "play":
      swingFrame(g, X(22), 30);
      break;
    case "system":
      gear(g, X(8), 14, 12, r);
      ladder(g, X(-14), 0, 52);
      waterButt(g, X(-4), 30, r);
      break;
  }
}
