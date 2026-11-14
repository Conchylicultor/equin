// Pages' building on Isle: the library — a pedimented stone hall with a carved
// open book, tall arched windows, ivy, and books stacked on the bench outside.

import {
  accent,
  bench,
  books,
  castShadow,
  doorArch,
  grain,
  hline,
  ink,
  ivy,
  lantern,
  moss,
  poly,
  shingles,
  shrub,
  spill,
  steps,
  stones,
  tufts,
  windowRect,
  type Box,
  type BuildingSpec,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const GRAIN_BOX: Box = [-170, -270, 160, 40];

export const library: BuildingSpec = {
  footprint: {
    w: 232,
    depth: 96,
    ground: [-155, -112, 188, 40],
    upper: [-126, -232, 127, -112],
  },
  setting: ["square", "lane"],
  signX: -150,
  lights: [
    [-86, -48, 14],
    [-52, -48, 14],
    [52, -48, 14],
    [86, -48, 14],
    [0, -30, 16],
  ],
  paint(g, s) {
    const r = s.rnd;
    const A = accent(s.hue);
    const W2 = 116;
    const WT = -98;
    castShadow(
      g,
      [
        [-W2 + 6, 3],
        [W2, 3],
        [W2 + 64, 24],
        [W2 + 27, -43],
        [W2, -96],
      ],
      0.3,
    );
    // roof: front gable, two slate slopes receding up and back
    shingles(
      g,
      [
        [-W2 - 8, WT + 2],
        [0, WT - 50],
        [0, WT - 132],
        [-W2 - 8, WT - 80],
      ],
      r,
      { base: "#6c6f73", rowH: 6.5, w: 10 },
    );
    const right: Pt[] = [
      [0, WT - 50],
      [W2 + 8, WT + 2],
      [W2 + 8, WT - 80],
      [0, WT - 132],
    ];
    shingles(g, right, r, {
      base: "#5f6266",
      rowH: 6.5,
      w: 10,
      shadeSide: right,
    });
    ink(g, 1.4);
    hline(g, 0, WT - 50, 0, WT - 132, r);
    // the facade
    stones(g, -W2, WT, W2, 0, r, { rowH: 12, blockW: 26, base: "#bdb5a2" });
    // pediment, cornice and the carved book
    const ped: Pt[] = [
      [-W2 - 6, WT],
      [0, WT - 52],
      [W2 + 6, WT],
    ];
    stones(g, -W2 - 6, WT - 52, W2 + 6, WT, r, {
      rowH: 9,
      blockW: 22,
      base: "#c4bca8",
      clip: () => poly(g, ped),
    });
    g.fillStyle = "#cfc7b2";
    g.fillRect(-W2 - 8, WT - 2, 2 * W2 + 16, 7);
    ink(g, 1.2);
    g.strokeRect(-W2 - 8, WT - 2, 2 * W2 + 16, 7);
    g.fillStyle = "rgba(30,26,20,.25)";
    g.fillRect(-W2, WT + 5, 2 * W2, 3);
    // book relief
    g.save();
    g.translate(0, WT - 20);
    const page = (d: number) => {
      g.beginPath();
      g.moveTo(0, 6);
      g.quadraticCurveTo(d * 10, 1, d * 22, 4);
      g.lineTo(d * 22, -10);
      g.quadraticCurveTo(d * 10, -13, 0, -8);
      g.closePath();
    };
    for (const d of [-1, 1]) {
      page(d);
      g.fillStyle = d < 0 ? "#d9d2be" : "#c2bba7";
      g.fill();
      ink(g, 1);
      g.stroke();
      ink(g, 0.6, 0.5);
      for (let k = 0; k < 4; k++)
        hline(g, d * 4, -6 + k * 3, d * 18, -7 + k * 3, r, 0.2);
    }
    g.restore();
    // pilasters
    for (const px of [-W2 + 4, -W2 + 48, W2 - 60, W2 - 16]) {
      g.fillStyle = "#c9c1ad";
      g.fillRect(px, WT + 6, 12, -WT - 6);
      g.fillStyle = "rgba(30,26,20,.18)";
      g.fillRect(px + 8, WT + 6, 4, -WT - 6);
      ink(g, 1);
      g.strokeRect(px, WT + 6, 12, -WT - 6);
    }
    // tall arched windows and the double door
    for (const wx of [-92, -58, 42, 76])
      windowRect(g, wx, -20, 18, 60, r, {
        arch: true,
        lit: s.night,
        frame: "#4e4436",
        sill: "#b3ab98",
      });
    doorArch(g, 0, 0, 34, 54, r, { col: A });
    ink(g, 0.9, 0.7);
    hline(g, 0, -40, 0, 0, r, 0.2);
    steps(g, 0, 2, 44, 2, r);
    // ivy up the corners, moss, a bench with books, book stacks
    ivy(g, -W2 + 6, 0, WT - 30, r, 26);
    ivy(g, W2 - 4, 0, -50, r, 16);
    moss(g, -W2, W2, 0, r, 16);
    tufts(g, -W2, W2, 2, r, 24);
    bench(g, 58, 26, 40, r);
    books(g, 66, 13, 3, r);
    books(g, -112, 24, 5, r);
    books(g, -88, 26, 3, r);
    lantern(g, -30, -64, s.night);
    lantern(g, 30, -64, s.night);
    for (const [x, y, z, k] of [
      [-132, 10, 18, 0],
      [128, 4, 16, 1],
      [-62, 34, 9, 2],
    ] as const)
      shrub(g, x, y, z, r, k);
    grain(g, GRAIN_BOX, r);
  },
  animate(g, s) {
    if (s.open) spill(g, 34, 0.45);
  },
};
