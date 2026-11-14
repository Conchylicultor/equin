// Sonata's building on Isle: the music hall — a dressed-stone hall whose great
// arched window shows a grand piano in a warm room, banners in the app's colour,
// and a lyre weathervane swinging on the roof.

import {
  accent,
  bbox,
  castShadow,
  doorArch,
  grain,
  hline,
  ink,
  lantern,
  moss,
  poly,
  shingles,
  shrub,
  spill,
  steps,
  stones,
  tufts,
  wash,
  windowRect,
  type Box,
  type BuildingSpec,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const GRAIN_BOX: Box = [-180, -290, 160, 40];
const WALL_TOP = -132;

export const musicHall: BuildingSpec = {
  footprint: {
    w: 236,
    depth: 100,
    ground: [-147, -112, 194, 39],
    upper: [-128, -245, 129, -112],
  },
  setting: ["square"],
  signX: -152,
  lights: [
    [0, -92, 40],
    [-84, -40, 14],
    [84, -40, 14],
    [0, -24, 14],
  ],
  paint(g, s) {
    const r = s.rnd;
    const A = accent(s.hue);
    const W2 = 118;
    const WT = WALL_TOP;
    castShadow(
      g,
      [
        [-W2 + 6, 3],
        [W2, 3],
        [W2 + 68, 26],
        [W2 + 29, -45],
        [W2, -100],
      ],
      0.3,
    );
    // hip roof in slate, lower wings either side
    shingles(
      g,
      [
        [-W2 + 26, WT + 4],
        [W2 - 26, WT + 4],
        [W2 - 64, WT - 70],
        [-W2 + 64, WT - 70],
      ],
      r,
      {
        base: "#5f6468",
        rowH: 6.5,
        w: 10,
        shadeSide: [
          [W2 - 26, WT + 4],
          [W2 - 64, WT - 70],
          [W2 - 84, WT - 70],
          [W2 - 48, WT + 4],
        ],
      },
    );
    ink(g, 1.3);
    hline(g, -W2 + 64, WT - 70, W2 - 64, WT - 70, r);
    shingles(
      g,
      [
        [-W2 - 8, -78],
        [-W2 + 30, -78],
        [-W2 + 30, -128],
        [-W2 + 4, -120],
      ],
      r,
      { base: "#686c70", rowH: 6, w: 9 },
    );
    shingles(
      g,
      [
        [W2 - 30, -78],
        [W2 + 8, -78],
        [W2 - 4, -120],
        [W2 - 30, -128],
      ],
      r,
      { base: "#5a5e62", rowH: 6, w: 9 },
    );
    // walls: dressed stone, the centre block taller
    stones(g, -W2, -80, -W2 + 32, 0, r, {
      rowH: 11,
      blockW: 22,
      base: "#b7af9c",
    });
    stones(g, W2 - 32, -80, W2, 0, r, {
      rowH: 11,
      blockW: 22,
      base: "#aea692",
    });
    stones(g, -W2 + 32, WT, W2 - 32, 0, r, {
      rowH: 13,
      blockW: 30,
      base: "#c1b9a5",
    });
    g.fillStyle = "#cfc7b2";
    g.fillRect(-W2 + 28, WT - 2, 2 * W2 - 56, 7);
    ink(g, 1.2);
    g.strokeRect(-W2 + 28, WT - 2, 2 * W2 - 56, 7);
    // the great arched window: a warm hall with the grand piano inside
    const wx0 = -44;
    const wx1 = 44;
    const wb = -46;
    const wtp = -122;
    const arch = () => {
      g.beginPath();
      g.moveTo(wx0, wb);
      g.lineTo(wx0, wtp + 44);
      g.arc(0, wtp + 44, 44, Math.PI, 0);
      g.lineTo(wx1, wb);
      g.closePath();
    };
    g.save();
    arch();
    g.clip();
    const hall = g.createLinearGradient(0, wtp, 0, wb);
    hall.addColorStop(0, s.night ? "#f2c879" : "#6b5a48");
    hall.addColorStop(1, s.night ? "#c98a45" : "#3e3329");
    g.fillStyle = hall;
    g.fillRect(wx0, wtp, 88, wb - wtp);
    g.fillStyle = s.night ? "rgba(120,70,30,.35)" : "rgba(20,16,12,.35)";
    g.fillRect(wx0, wb - 14, 88, 14); // floor
    // grand piano: curved case, propped lid, legs
    g.save();
    g.translate(-4, wb - 8);
    g.fillStyle = "#16130f";
    g.beginPath();
    g.moveTo(-26, 0);
    g.lineTo(-26, -10);
    g.lineTo(6, -10);
    g.bezierCurveTo(20, -10, 22, -2, 30, -2);
    g.lineTo(30, 0);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(-24, -10);
    g.lineTo(18, -40);
    g.lineTo(22, -36);
    g.lineTo(-18, -10);
    g.closePath();
    g.fill(); // the lid
    g.strokeStyle = "#16130f";
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(4, -10);
    g.lineTo(8, -26);
    g.stroke(); // prop stick
    g.fillStyle = "#ece4d0";
    g.fillRect(-26, -12, 12, 2);
    g.fillStyle = "#16130f";
    for (let k = 0; k < 5; k++) g.fillRect(-25 + k * 2.4, -12, 1, 1.2);
    g.fillRect(-24, 0, 2, 6);
    g.fillRect(24, -2, 2, 8);
    g.fillRect(-2, 0, 2, 6);
    g.fillStyle = "#3b2e24";
    g.fillRect(-34, -4, 6, 10); // stool
    g.restore();
    g.fillStyle = s.night ? "rgba(255,230,170,.35)" : "rgba(200,215,220,.18)";
    g.beginPath();
    g.moveTo(wx0, wb - 40);
    g.lineTo(wx0 + 30, wtp + 10);
    g.lineTo(wx0 + 40, wtp + 10);
    g.lineTo(wx0 + 10, wb - 40);
    g.fill();
    g.restore();
    const mullionTop = (k: number) =>
      wtp + 44 - Math.sqrt(Math.max(0, 44 * 44 - (k * 22) ** 2));
    g.strokeStyle = "#4e4436";
    g.lineWidth = 2.4;
    g.beginPath();
    for (let k = -1; k <= 1; k++) {
      g.moveTo(k * 22, wb);
      g.lineTo(k * 22, mullionTop(k));
    }
    g.moveTo(wx0, -84);
    g.lineTo(wx1, -84);
    g.stroke();
    ink(g, 0.6, 0.6);
    g.beginPath();
    for (let k = -1; k <= 1; k++) {
      g.moveTo(k * 22 - 1.2, wb);
      g.lineTo(k * 22 - 1.2, mullionTop(k));
    }
    g.stroke();
    arch();
    ink(g, 1.5);
    g.stroke();
    g.save();
    g.strokeStyle = "#a9a18f";
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(wx0 - 3, wb);
    g.lineTo(wx0 - 3, wtp + 44);
    g.arc(0, wtp + 44, 47, Math.PI, 0);
    g.lineTo(wx1 + 3, wb);
    g.stroke();
    g.restore();
    ink(g, 0.8, 0.5);
    g.beginPath();
    g.arc(0, wtp + 44, 50, Math.PI, 0);
    g.stroke();
    g.fillStyle = "#a9a18f";
    g.fillRect(wx0 - 6, wb, wx1 - wx0 + 12, 5);
    ink(g, 1);
    g.strokeRect(wx0 - 6, wb, wx1 - wx0 + 12, 5);
    // door below, banners in the accent on the pilasters, side windows
    doorArch(g, 0, 0, 26, 38, r, { col: "#5a4432" });
    for (const bx of [-W2 + 44, W2 - 56]) {
      g.fillStyle = "#c9c1ad";
      g.fillRect(bx, WT + 6, 12, -WT - 6);
      ink(g, 1);
      g.strokeRect(bx, WT + 6, 12, -WT - 6);
      const ban: Pt[] = [
        [bx - 1, WT + 14],
        [bx + 13, WT + 14],
        [bx + 13, WT + 62],
        [bx + 6, WT + 56],
        [bx - 1, WT + 62],
      ];
      wash(g, () => poly(g, ban), bbox(ban), A, r, { blob: 3, var: 18 });
      g.fillStyle = "rgba(240,225,190,.7)";
      g.beginPath();
      g.ellipse(bx + 6, WT + 30, 2.2, 1.6, -0.4, 0, 7);
      g.fill();
      g.fillRect(bx + 7.6, WT + 22, 1, 8);
    }
    windowRect(g, -W2 + 8, -26, 16, 34, r, { arch: true, lit: s.night });
    windowRect(g, W2 - 24, -26, 16, 34, r, { arch: true, lit: s.night });
    steps(g, 0, 3, 40, 3, r);
    lantern(g, -22, -40, s.night);
    lantern(g, 22, -40, s.night);
    moss(g, -W2, W2, 0, r, 12);
    tufts(g, -W2, W2, 2, r, 22);
    g.fillStyle = "#4a4640";
    g.fillRect(-1, WT - 70 - 24, 2, 24); // the weathervane's mast (the vane is animated)
    for (const [x, y, z, k] of [
      [-134, 8, 17, 0],
      [132, 8, 16, 1],
      [-70, 30, 9, 2],
    ] as const)
      shrub(g, x, y, z, r, k);
    grain(g, GRAIN_BOX, r);
  },
  animate(g, s) {
    // the lyre weathervane swinging in the wind
    const y = WALL_TOP - 70 - 24;
    const a = Math.sin(s.t * 0.6) * 0.35 + Math.sin(s.t * 1.7) * 0.08;
    g.save();
    g.translate(0, y);
    g.scale(Math.cos(a), 1);
    g.strokeStyle = "#3e3a35";
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(-7, 0);
    g.quadraticCurveTo(-11, -10, -5, -16);
    g.moveTo(7, 0);
    g.quadraticCurveTo(11, -10, 5, -16);
    g.moveTo(-7, 0);
    g.lineTo(7, 0);
    g.moveTo(-5, -12);
    g.lineTo(5, -12);
    for (let k = -1; k <= 1; k++) {
      g.moveTo(k * 2.5, 0);
      g.lineTo(k * 2.5, -12);
    }
    g.stroke();
    g.beginPath();
    g.moveTo(-14, 6);
    g.lineTo(14, 6);
    g.stroke();
    g.fillStyle = "#3e3a35";
    g.beginPath();
    g.moveTo(14, 6);
    g.lineTo(10, 3);
    g.lineTo(10, 9);
    g.fill();
    g.restore();
    if (s.open) spill(g, 30, 0.45);
  },
};
