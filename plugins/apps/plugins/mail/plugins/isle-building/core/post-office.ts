// Mail's building on Isle: the post office — timber frame over plaster under a
// clay-tile roof, a dovecote on the ridge (a pigeon hops and flaps), an
// envelope sign, a pillar mailbox and parcels under a canvas awning.

import {
  accent,
  bbox,
  castShadow,
  crate,
  dark,
  grain,
  hline,
  ink,
  moss,
  planks,
  poly,
  sack,
  shingles,
  shrub,
  spill,
  stones,
  tufts,
  wash,
  windowRect,
  type Box,
  type BuildingSpec,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const GRAIN_BOX: Box = [-150, -250, 180, 40];
const FLOWERS = ["#7a8a48", "#5f6e37", "#b9895a", "#c9b27a"] as const;

export const postOffice: BuildingSpec = {
  footprint: {
    w: 206,
    depth: 84,
    ground: [-144, -112, 169, 39],
    upper: [-117, -214, 118, -112],
  },
  setting: ["square"],
  signX: 140,
  lights: [
    [-60, -36, 14],
    [58, -36, 14],
    [0, -24, 14],
  ],
  paint(g, s) {
    const r = s.rnd;
    const A = accent(s.hue);
    const W2 = 103;
    const WT = -84;
    castShadow(
      g,
      [
        [-W2 + 6, 3],
        [W2, 3],
        [W2 + 58, 22],
        [W2 + 24, -37],
        [W2, -84],
      ],
      0.3,
    );
    // steep clay-tile roof, ridge parallel to the street
    shingles(
      g,
      [
        [-W2 - 12, WT + 4],
        [W2 + 12, WT + 4],
        [W2 - 4, WT - 82],
        [-W2 + 4, WT - 82],
      ],
      r,
      { base: "#8e6250", rowH: 6, w: 8, round: true, var: 26 },
    );
    ink(g, 1.4);
    hline(g, -W2 + 4, WT - 82, W2 - 4, WT - 82, r);
    g.fillStyle = "#7d5444";
    g.fillRect(-W2 + 4, WT - 86, 2 * W2 - 8, 5);
    ink(g, 1);
    g.strokeRect(-W2 + 4, WT - 86, 2 * W2 - 8, 5);
    // dovecote on the ridge
    planks(g, 34, WT - 116, 58, WT - 86, r, { base: "#8a7253", pw: 5 });
    g.fillStyle = "#6e5a46";
    poly(g, [
      [30, WT - 116],
      [46, WT - 128],
      [62, WT - 116],
    ]);
    g.fill();
    ink(g, 1.1);
    g.stroke();
    for (const [hx, hy] of [
      [39, WT - 106],
      [51, WT - 106],
    ] as const) {
      g.fillStyle = "#1f1b17";
      g.beginPath();
      g.arc(hx, hy, 3, Math.PI, 0);
      g.lineTo(hx + 3, hy + 3);
      g.lineTo(hx - 3, hy + 3);
      g.fill();
    }
    // timber frame over plaster, on a stone plinth
    wash(
      g,
      () => {
        g.beginPath();
        g.rect(-W2, WT, 2 * W2, -WT - 14);
      },
      [-W2, WT, W2, -14],
      "#d8cdb2",
      r,
      { blob: 10, var: 18 },
    );
    stones(g, -W2, -14, W2, 0, r, { rowH: 7, blockW: 16, base: "#a59d8b" });
    const beam = (x0: number, y0: number, x1: number, y1: number, wdt = 5) => {
      g.save();
      g.strokeStyle = "#5a4632";
      g.lineWidth = wdt;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.strokeStyle = "rgba(255,240,210,.12)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x0 - 1, y0);
      g.lineTo(x1 - 1, y1);
      g.stroke();
      g.restore();
      ink(g, 0.7, 0.55);
      hline(g, x0 - wdt / 2, y0, x1 - wdt / 2, y1, r, 0.3);
      hline(g, x0 + wdt / 2, y0, x1 + wdt / 2, y1, r, 0.3);
    };
    beam(-W2, WT + 2, W2, WT + 2, 6);
    beam(-W2, -15, W2, -15, 5);
    for (const x of [-W2 + 3, -40, -16, 16, 40, W2 - 3])
      beam(x, WT + 2, x, -15);
    beam(-W2 + 3, WT + 2, -40, -15, 4);
    beam(-40, WT + 2, -W2 + 3, -15, 4);
    beam(W2 - 3, WT + 2, 40, -15, 4);
    beam(40, WT + 2, W2 - 3, -15, 4);
    // door and windows with flower boxes
    g.save();
    g.beginPath();
    g.rect(-13, -50, 26, 50);
    g.clip();
    planks(g, -13, -50, 13, 0, r, { base: A, pw: 6.5 });
    g.restore();
    ink(g, 1.4);
    g.strokeRect(-13, -50, 26, 50);
    windowRect(g, -14, -52, 28, 10, r, { lit: s.night }); // transom
    g.fillStyle = "#c2a060";
    g.beginPath();
    g.arc(8, -24, 1.6, 0, 7);
    g.fill();
    for (const [wx, wy] of [
      [-74, -22],
      [44, -22],
    ] as const) {
      windowRect(g, wx, wy, 28, 32, r, { lit: s.night });
      planks(g, wx - 2, wy + 2, wx + 30, wy + 8, r, {
        base: "#6e5a46",
        vertical: false,
        pw: 6,
      });
      for (let k = 0; k < 9; k++) {
        g.fillStyle = FLOWERS[(r() * 4) | 0]!;
        g.beginPath();
        g.arc(wx + 1 + k * 3.4, wy + 1 - r() * 3, 2 + r(), 0, 7);
        g.fill();
      }
    }
    // the hanging envelope sign
    ink(g, 1.4);
    hline(g, -26, -66, -46, -66, r);
    hline(g, -30, -66, -30, -62, r);
    hline(g, -42, -66, -42, -62, r);
    wash(
      g,
      () => {
        g.beginPath();
        g.rect(-48, -62, 24, 15);
      },
      [-48, -62, -24, -47],
      "#e6dcc2",
      r,
      { blob: 3 },
    );
    ink(g, 1);
    g.beginPath();
    g.moveTo(-48, -62);
    g.lineTo(-36, -53);
    g.lineTo(-24, -62);
    g.stroke();
    g.fillStyle = A;
    g.beginPath();
    g.arc(-36, -52, 2.4, 0, 7);
    g.fill();
    // pillar mailbox (accent), parcels and sacks under a canvas awning
    const mx = -48;
    const my = 22;
    castShadow(
      g,
      [
        [mx - 8, my],
        [mx + 8, my],
        [mx + 16, my + 5],
        [mx, my + 5],
      ],
      0.35,
    );
    wash(
      g,
      () => {
        g.beginPath();
        g.moveTo(mx - 8, my);
        g.lineTo(mx - 8, my - 34);
        g.quadraticCurveTo(mx, my - 44, mx + 8, my - 34);
        g.lineTo(mx + 8, my);
        g.closePath();
      },
      [mx - 8, my - 44, mx + 8, my],
      accent(s.hue, 0.12),
      r,
      { blob: 4, var: 20, shadeA: 0.35 },
    );
    g.fillStyle = "#1f1b17";
    g.fillRect(mx - 5, my - 30, 10, 2);
    g.fillStyle = "rgba(255,240,210,.25)";
    g.fillRect(mx - 6, my - 38, 2, 30);
    g.fillStyle = "#3a332c";
    g.fillRect(mx - 9, my - 3, 18, 3);
    const aw: Pt[] = [
      [56, -50],
      [104, -50],
      [112, -36],
      [50, -36],
    ];
    wash(g, () => poly(g, aw), bbox(aw), "#b9ac8a", r, { blob: 4, var: 16 });
    for (let k = 0; k < 4; k++) {
      g.fillStyle = dark(A, 0.1, 0.55);
      poly(g, [
        [58 + k * 12, -50],
        [64 + k * 12, -50],
        [60 + k * 13.5, -36],
        [54 + k * 13.5, -36],
      ]);
      g.fill();
    }
    crate(g, 70, 18, 14, r);
    crate(g, 86, 20, 12, r);
    crate(g, 76, 6, 11, r);
    sack(g, 104, 22, 8, r);
    sack(g, 114, 16, 7, r);
    ink(g, 0.9, 0.6);
    hline(g, 71, 11, 83, 11, r);
    hline(g, 77, 18, 77, 6, r); // string on a parcel
    // the dovecote's pole-mounted twin by the corner
    g.fillStyle = "#5a4632";
    g.fillRect(-128, -60, 4, 64);
    planks(g, -138, -82, -114, -60, r, { base: "#8a7253", pw: 5 });
    g.fillStyle = "#6e5a46";
    poly(g, [
      [-142, -82],
      [-126, -94],
      [-110, -82],
    ]);
    g.fill();
    ink(g, 1.1);
    g.stroke();
    g.fillStyle = "#1f1b17";
    g.beginPath();
    g.arc(-126, -71, 3, Math.PI, 0);
    g.lineTo(-123, -68);
    g.lineTo(-129, -68);
    g.fill();
    moss(g, -W2, W2, 0, r, 10);
    tufts(g, -W2, W2, 2, r, 22);
    for (const [x, y, z, k] of [
      [-112, 10, 14, 1],
      [-82, 32, 9, 0],
      [128, 2, 12, 2],
    ] as const)
      shrub(g, x, y, z, r, k);
    grain(g, GRAIN_BOX, r);
  },
  animate(g, s) {
    // a pigeon on the dovecote ledge: hops, sometimes flaps
    const t = s.t;
    const ph = t % 6;
    const flap = ph > 4.5 && ph < 5.4;
    const hop =
      ph > 2 && ph < 2.4 ? Math.sin(((ph - 2) / 0.4) * Math.PI) * 4 : 0;
    const px = 40 + (ph > 2.2 ? 8 : 0);
    const py = -84 - 86 + 13 - hop;
    g.fillStyle = "#8e9298";
    g.beginPath();
    g.ellipse(px, py, 5, 3.4, 0, 0, 7);
    g.fill();
    g.beginPath();
    g.arc(px + 4, py - 3, 2.2, 0, 7);
    g.fill();
    g.fillStyle = "#c79a5a";
    g.fillRect(px + 6, py - 3, 2, 1);
    ink(g, 0.7, 0.7);
    g.beginPath();
    g.ellipse(px, py, 5, 3.4, 0, 0, 7);
    g.stroke();
    if (flap) {
      const a = Math.sin(t * 30) * 0.8;
      g.fillStyle = "#a6aab0";
      g.save();
      g.translate(px - 1, py - 1);
      g.rotate(-0.6 + a);
      g.beginPath();
      g.ellipse(-5, 0, 6, 2, 0, 0, 7);
      g.fill();
      g.restore();
    }
    if (s.open) spill(g, 30, 0.45);
  },
};
