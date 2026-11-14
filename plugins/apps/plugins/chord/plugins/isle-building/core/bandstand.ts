// Chord's building on Isle: the bandstand — an octagonal timber stand on a
// stone plinth, a guitar on its stand and a music stand inside, a shingled
// roof with a valance in the app's colour and a pennant at the finial.

import {
  accent,
  bbox,
  castShadow,
  dark,
  grain,
  hline,
  ink,
  jit,
  lantern,
  planks,
  poly,
  shingles,
  shrub,
  spill,
  stones,
  tufts,
  wash,
  type Box,
  type BuildingSpec,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const GRAIN_BOX: Box = [-130, -240, 170, 40];
const RX = 82;
const RY = 40;
const CY = -46;
const H = 72;

/** The eight corners of an octagon of radii (rx, ry) round (0, cy), a flat side at the front. */
const oct = (rx: number, ry: number, cy: number): Pt[] =>
  Array.from({ length: 8 }, (_, k) => {
    const a = ((k + 0.5) * Math.PI) / 4;
    return [Math.cos(a) * rx, cy + Math.sin(a) * ry] as const;
  });

export const bandstand: BuildingSpec = {
  footprint: {
    w: 196,
    depth: 100,
    ground: [-111, -112, 150, 39],
    upper: [-93, -206, 93, -112],
  },
  setting: ["square"],
  signX: 134,
  lights: [
    [-62, -86, 12],
    [62, -86, 12],
    [0, -40, 30],
  ],
  paint(g, s) {
    const r = s.rnd;
    const A = accent(s.hue);
    castShadow(
      g,
      [
        [-RX, CY + 30],
        [RX, CY + 30],
        [RX + 60, CY + 50],
        [RX + 40, CY - 10],
        [0, CY - 30],
      ],
      0.28,
    );
    // raised stone plinth
    const top = oct(RX, RY, CY);
    const base: Pt[] = top.map(([x, y]) => [x, y + 14]);
    const T = (k: number) => top[k % 8]!;
    for (let k = 0; k < 8; k++) {
      const a = T(k);
      const b = T(k + 1);
      if (a[1] < CY && b[1] < CY) continue;
      const face: Pt[] = [a, b, base[(k + 1) % 8]!, base[k]!];
      stones(
        g,
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]) + 14,
        r,
        { rowH: 7, blockW: 14, base: "#a59d8b", clip: () => poly(g, face) },
      );
    }
    // the floor
    g.save();
    poly(g, top);
    g.clip();
    planks(g, -RX, CY - RY, RX, CY + RY, r, {
      base: "#8f7858",
      vertical: false,
      pw: 6,
    });
    g.restore();
    poly(g, top);
    ink(g, 1.3);
    g.stroke();
    const post = ([x, y]: Pt) => {
      planks(g, x - 3, y - H, x + 3, y, r, { base: "#7a6448", pw: 6 });
      g.fillStyle = "#5c4a36";
      g.fillRect(x - 4, y - 3, 8, 3);
    };
    const rail = (a: Pt, b: Pt) => {
      ink(g, 1.1);
      hline(g, a[0], a[1] - 18, b[0], b[1] - 18, r, 0.3);
      g.strokeStyle = "#6e5a44";
      g.lineWidth = 1.2;
      for (let k = 1; k < 6; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / 6;
        const y = a[1] + ((b[1] - a[1]) * k) / 6;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y - 18);
        g.stroke();
      }
    };
    // back posts and rails
    for (const k of [3, 4, 5, 6]) post(T(k));
    rail(T(4), T(5));
    rail(T(5), T(6));
    rail(T(3), T(4));
    rail(T(6), T(7));
    // inside: a stool, a guitar on its stand, a music stand
    g.fillStyle = "#5c4a36";
    g.fillRect(-26, CY - 2, 3, 12);
    g.fillRect(-14, CY - 2, 3, 12);
    g.fillStyle = "#7d6648";
    g.beginPath();
    g.ellipse(-18, CY - 3, 9, 3.5, 0, 0, 7);
    g.fill();
    ink(g, 1);
    g.stroke();
    g.save();
    g.translate(14, CY + 4);
    g.rotate(-0.18);
    g.fillStyle = "#3e3a35";
    g.fillRect(-1, -2, 2, 8);
    g.strokeStyle = "#3e3a35";
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-6, 6);
    g.lineTo(0, 0);
    g.lineTo(6, 6);
    g.stroke();
    g.beginPath();
    g.ellipse(0, -8, 8, 9, 0, 0, 7);
    g.ellipse(0, -21, 6, 6.5, 0, 0, 7);
    g.fillStyle = "#9a6a3a";
    g.fill();
    ink(g, 1);
    g.beginPath();
    g.ellipse(0, -8, 8, 9, 0, 0, 7);
    g.stroke();
    g.beginPath();
    g.ellipse(0, -21, 6, 6.5, 0, 0, 7);
    g.stroke();
    g.fillStyle = "#1f1b17";
    g.beginPath();
    g.arc(0, -15, 2.4, 0, 7);
    g.fill();
    g.fillStyle = "#3e2e22";
    g.fillRect(-1.5, -46, 3, 26);
    g.fillRect(-2.5, -50, 5, 5);
    g.restore();
    g.strokeStyle = "#3e3a35";
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(44, CY + 8);
    g.lineTo(44, CY - 18);
    g.moveTo(40, CY + 8);
    g.lineTo(44, CY + 2);
    g.lineTo(48, CY + 8);
    g.stroke();
    g.fillStyle = "#e6dcc2";
    poly(g, [
      [37, CY - 26],
      [51, CY - 26],
      [49, CY - 16],
      [39, CY - 16],
    ]);
    g.fill();
    ink(g, 0.8);
    g.stroke();
    // front posts and rails (the gap at the front is the entrance)
    for (const k of [7, 0, 1, 2]) post(T(k));
    rail(T(7), T(0));
    rail(T(1), T(2));
    // front steps
    for (let i = 0; i < 3; i++) {
      const yy = CY + RY + 4 + i * 4;
      const ww = 30 + i * 6;
      g.fillStyle = jit("#a49d8c", r, 12);
      g.fillRect(-ww / 2, yy, ww, 4);
      ink(g, 0.9, 0.6);
      g.strokeRect(-ww / 2, yy, ww, 4);
    }
    // octagonal shingled roof seen from above
    const eave = oct(RX + 14, RY + 10, CY - H);
    const E = (k: number) => eave[k % 8]!;
    const apex: Pt = [0, CY - H - 64];
    for (let k = 0; k < 8; k++)
      shingles(g, [E(k), E(k + 1), apex], r, {
        base: k >= 1 && k <= 3 ? "#6e6252" : k >= 5 ? "#857865" : "#7a6d5b",
        rowH: 5.5,
        w: 8,
        var: 30,
      });
    // eave fringe in the accent: a faded painted valance
    for (let k = 0; k < 8; k++) {
      const a = E(k);
      const b = E(k + 1);
      if (a[1] < CY - H - 6 && b[1] < CY - H - 6) continue;
      const v: Pt[] = [a, b, [b[0], b[1] + 6], [a[0], a[1] + 6]];
      wash(g, () => poly(g, v), bbox(v), A, r, { blob: 2, var: 14, lw: 1 });
      for (let j = 0; j < 4; j++) {
        const x = a[0] + ((b[0] - a[0]) * (j + 0.5)) / 4;
        const y = a[1] + ((b[1] - a[1]) * (j + 0.5)) / 4 + 6;
        g.fillStyle = dark(A, 0.2);
        g.beginPath();
        g.moveTo(x - 3, y);
        g.lineTo(x + 3, y);
        g.lineTo(x, y + 4);
        g.fill();
      }
    }
    g.fillStyle = "#3e3a35";
    g.fillRect(-1.5, apex[1] - 22, 3, 24);
    lantern(g, -62, CY - H + 18, s.night);
    lantern(g, 62, CY - H + 18, s.night);
    tufts(g, -RX, RX, CY + RY + 16, r, 18);
    for (const [x, y, z, k] of [
      [-96, -10, 15, 0],
      [100, -6, 14, 1],
      [-60, 14, 9, 2],
    ] as const)
      shrub(g, x, y, z, r, k);
    grain(g, GRAIN_BOX, r);
  },
  animate(g, s) {
    // a pennant at the finial
    const y = CY - H - 64 - 22;
    const t = s.t;
    g.fillStyle = accent(s.hue);
    g.beginPath();
    g.moveTo(1, y);
    for (let k = 0; k <= 6; k++)
      g.lineTo(
        1 + k * 3.4,
        y + 3 + Math.sin(t * 4 - k * 0.8) * 2 * (k / 6) + k * 0.4,
      );
    for (let k = 6; k >= 0; k--)
      g.lineTo(
        1 + k * 3.4,
        y + 10 - k * 0.9 + Math.sin(t * 4 - k * 0.8) * 2 * (k / 6),
      );
    g.closePath();
    g.fill();
    ink(g, 0.9);
    g.stroke();
    if (s.open) spill(g, 34, 0.35);
  },
};
