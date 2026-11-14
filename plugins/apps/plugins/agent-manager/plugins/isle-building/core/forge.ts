// The Agent Manager's building on Isle: the workshop forge, its bay open on a
// brass automaton hammering at the bench while the forge glows behind.

import {
  accent,
  barrel,
  castShadow,
  crate,
  dark,
  grain,
  hline,
  ink,
  moss,
  planks,
  shingles,
  shrub,
  spill,
  stones,
  tufts,
  wash,
  windowRect,
  type Box,
  type BuildingSpec,
  type Ctx2D,
  type Rnd,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

/** The box the watercolour grain covers. */
const GRAIN_BOX: Box = [-160, -310, 160, 30];

/** A sober brass figure, seen from the side, working at a bench. */
function automaton(g: Ctx2D, x: number, y: number, rnd: Rnd): void {
  const brass = "#a8874f";
  g.fillStyle = "rgba(30,26,20,.3)";
  g.beginPath();
  g.ellipse(x + 3, y, 9, 3, 0, 0, 7);
  g.fill();
  g.fillStyle = "#4a443c";
  g.fillRect(x - 5, y - 16, 3.5, 16);
  g.fillRect(x + 1.5, y - 16, 3.5, 16);
  wash(
    g,
    () => {
      g.beginPath();
      g.roundRect(x - 8, y - 38, 16, 23, 4);
    },
    [x - 8, y - 38, x + 8, y - 15],
    brass,
    rnd,
    { blob: 4, var: 30, lw: 1.1 },
  );
  g.fillStyle = "#6c5a3a";
  g.fillRect(x - 8, y - 28, 16, 2);
  g.fillStyle = "#d6b97a";
  g.beginPath();
  g.arc(x - 3, y - 33, 1.2, 0, 7);
  g.arc(x + 2, y - 33, 1.2, 0, 7);
  g.fill();
  wash(
    g,
    () => {
      g.beginPath();
      g.arc(x, y - 45, 7, 0, 7);
    },
    [x - 7, y - 52, x + 7, y - 38],
    brass,
    rnd,
    { blob: 3, var: 30, lw: 1.1 },
  );
  g.fillStyle = "#2a2622";
  g.beginPath();
  g.arc(x + 3.5, y - 45.5, 2.6, 0, 7);
  g.fill();
  g.fillStyle = "#e9c46a";
  g.beginPath();
  g.arc(x + 3.5, y - 45.5, 1.1, 0, 7);
  g.fill();
  g.fillStyle = "#4a443c";
  g.fillRect(x - 1, y - 40, 2, 3);
}

export const forge: BuildingSpec = {
  footprint: {
    w: 214,
    depth: 84,
    ground: [-148, -112, 175, 39],
    upper: [-119, -297, 120, -112],
  },
  setting: ["lane"],
  signX: -138,
  chimney: { x: -72, y: -212, puffs: 7 },
  lights: [
    [-80, -40, 16],
    [74, -40, 16],
    [0, -28, 34],
  ],
  paint(g, s) {
    const r = s.rnd;
    const A = accent(s.hue);
    const W2 = 107;
    const WT = -76;
    castShadow(
      g,
      [
        [-W2 + 6, 3],
        [W2, 3],
        [W2 + 60, 22],
        [W2 + 25, -37],
        [W2, -84],
      ],
      0.3,
    );
    // roof (hip, stone slates) seen from above, then the chimney on its back slope
    shingles(
      g,
      [
        [-W2 - 10, WT + 4],
        [W2 + 10, WT + 4],
        [W2 - 36, WT - 74],
        [-W2 + 36, WT - 74],
      ],
      r,
      {
        base: "#7a756c",
        rowH: 7,
        w: 11,
        var: 34,
        shadeSide: [
          [W2 + 10, WT + 4],
          [W2 - 36, WT - 74],
          [W2 - 60, WT - 74],
          [W2 - 20, WT + 4],
        ],
      },
    );
    ink(g, 1.2, 0.7);
    hline(g, -W2 + 36, WT - 74, W2 - 36, WT - 74, r); // ridge
    stones(g, -84, -206, -60, WT - 44, r, {
      rowH: 7,
      blockW: 10,
      base: "#9d9484",
    });
    g.fillStyle = "#3a352e";
    g.fillRect(-87, -210, 30, 5);
    ink(g, 1);
    g.strokeRect(-87, -210, 30, 5);
    // walls: rubble stone with a timber band
    stones(g, -W2, WT, W2, 0, r, { rowH: 11, blockW: 20, base: "#ada593" });
    planks(g, -W2, WT, W2, WT + 8, r, {
      base: "#6b5640",
      vertical: false,
      pw: 8,
    });
    // the open bay: dark interior, forge glow at the back, workbench, automaton
    const bx0 = -40;
    const bx1 = 40;
    const bt = -64;
    g.save();
    g.beginPath();
    g.rect(bx0, bt, bx1 - bx0, -bt);
    g.clip();
    const gi = g.createLinearGradient(0, bt, 0, 0);
    gi.addColorStop(0, "#1f1b17");
    gi.addColorStop(1, "#3b322a");
    g.fillStyle = gi;
    g.fillRect(bx0, bt, 80, -bt);
    stones(g, -30, -50, -6, -18, r, {
      rowH: 6,
      blockW: 9,
      base: "#5d554a",
      mortar: "#2d2822",
    }); // the forge
    g.fillStyle = s.night ? "#ffb35a" : "#e38a3c";
    g.beginPath();
    g.ellipse(-18, -30, 8, 4, 0, 0, 7);
    g.fill();
    g.fillStyle = "#4a4038";
    g.fillRect(-4, -36, 4, 2); // tongs
    // tools on the back wall
    ink(g, 1.2, 0.85);
    for (const [a, b, c, d] of [
      [8, -58, 8, -44],
      [14, -58, 13, -46],
      [20, -58, 22, -47],
      [26, -58, 26, -50],
    ] as const)
      hline(g, a, b, c, d, r);
    g.fillStyle = "#6b5a46";
    g.fillRect(4, -60, 26, 2.5);
    // a gear hung on the wall
    g.strokeStyle = "#8c7a52";
    g.lineWidth = 2.2;
    g.beginPath();
    g.arc(30, -38, 6, 0, 7);
    g.stroke();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      g.beginPath();
      g.moveTo(30 + Math.cos(a) * 6, -38 + Math.sin(a) * 6);
      g.lineTo(30 + Math.cos(a) * 8.5, -38 + Math.sin(a) * 8.5);
      g.stroke();
    }
    planks(g, -4, -22, 38, -17, r, {
      base: "#7d6648",
      vertical: false,
      pw: 5,
    });
    g.fillStyle = "#4b3d2e";
    g.fillRect(0, -17, 3, 17);
    g.fillRect(33, -17, 3, 17); // bench
    g.fillStyle = "#8c8f92";
    g.fillRect(8, -25, 10, 3);
    g.fillStyle = "#b08d57";
    g.beginPath();
    g.arc(26, -24, 3, 0, 7);
    g.fill();
    automaton(g, 14, -1, r);
    g.restore();
    // heavy timber lintel and posts
    planks(g, bx0 - 6, bt - 10, bx1 + 6, bt, r, {
      base: "#5e4a36",
      vertical: false,
      pw: 5,
    });
    planks(g, bx0 - 6, bt, bx0, 0, r, { base: "#5e4a36", pw: 6 });
    planks(g, bx1, bt, bx1 + 6, 0, r, { base: "#5e4a36", pw: 6 });
    // windows with accent shutters
    windowRect(g, -86, -24, 16, 26, r, { lit: s.night, shutters: A });
    windowRect(g, 66, -24, 16, 26, r, { lit: s.night, shutters: A });
    // hanging sign bracket with a gear (accent)
    ink(g, 1.3);
    hline(g, 50, -66, 64, -66, r);
    g.fillStyle = A;
    g.beginPath();
    g.arc(60, -56, 7, 0, 7);
    g.fill();
    ink(g, 1);
    g.stroke();
    g.fillStyle = dark(A, 0.3);
    g.beginPath();
    g.arc(60, -56, 2.5, 0, 7);
    g.fill();
    ink(g, 0.8);
    hline(g, 56, -66, 57, -63, r);
    hline(g, 64, -66, 63, -63, r);
    // ground: anvil, water barrel, crates, a cart wheel, tufts and moss
    g.fillStyle = "rgba(38,44,24,.25)";
    g.beginPath();
    g.ellipse(-56, 6, 14, 4, 0, 0, 7);
    g.fill();
    g.fillStyle = "#3e3c3a";
    g.beginPath();
    g.moveTo(-66, -9);
    g.lineTo(-44, -9);
    g.lineTo(-48, -5);
    g.lineTo(-52, -5);
    g.lineTo(-52, 2);
    g.lineTo(-60, 2);
    g.lineTo(-60, -5);
    g.lineTo(-64, -5);
    g.closePath();
    g.fill();
    ink(g, 1);
    g.stroke();
    g.fillStyle = "#5a4a38";
    g.fillRect(-62, 2, 12, 4);
    barrel(g, -96, 10, 9, r);
    crate(g, 84, 12, 15, r);
    crate(g, 96, 2, 12, r);
    ink(g, 1.4);
    g.strokeStyle = "#5a4632";
    g.lineWidth = 2.5;
    g.beginPath();
    g.ellipse(-122, -8, 6, 15, 0.1, 0, 7);
    g.stroke();
    ink(g, 0.8);
    g.beginPath();
    g.ellipse(-122, -8, 6, 15, 0.1, 0, 7);
    g.stroke();
    moss(g, -W2, W2, 0, r, 14);
    tufts(g, -W2, W2, 1, r, 22);
    for (const [x, y, z, k] of [
      [-122, 14, 16, 0],
      [116, -2, 14, 1],
      [-134, -14, 11, 2],
    ] as const)
      shrub(g, x, y, z, r, k);
    grain(g, GRAIN_BOX, r);
  },
  animate(g, s) {
    const t = s.t;
    // forge flicker, and sparks when the hammer falls
    const f = 0.6 + Math.sin(t * 9) * 0.2 + Math.sin(t * 23) * 0.15;
    g.save();
    g.globalCompositeOperation = "lighter";
    const gr = g.createRadialGradient(-18, -30, 1, -18, -30, 26);
    gr.addColorStop(0, `rgba(255,150,60,${0.55 * f})`);
    gr.addColorStop(1, "rgba(255,120,40,0)");
    g.fillStyle = gr;
    g.fillRect(-44, -56, 52, 52);
    const ph = (t * 1.3) % 1;
    const arm = ph < 0.8 ? -0.9 + ph * 0.6 : -0.42 - (ph - 0.8) * 4;
    if (ph > 0.95 || ph < 0.05)
      for (let i = 0; i < 6; i++) {
        g.fillStyle = `rgba(255,${190 + i * 10},90,.9)`;
        g.fillRect(
          22 + Math.cos(i) * (4 + i * 2),
          -27 - Math.abs(Math.sin(i * 2)) * (3 + i * 1.5),
          1.4,
          1.4,
        );
      }
    g.restore();
    // the automaton's hammer arm
    g.save();
    g.translate(18, -34);
    g.rotate(arm + 0.9);
    g.strokeStyle = "#8a6e40";
    g.lineWidth = 3;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(9, 5);
    g.stroke();
    g.fillStyle = "#3e3c3a";
    g.fillRect(8, 1, 3, 9);
    ink(g, 0.8);
    g.strokeRect(8, 1, 3, 9);
    g.restore();
    if (s.open) spill(g, 70, 0.4);
  },
};
