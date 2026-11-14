// Settings' building on Isle: the tower windmill — a tapering stone tower with
// a wooden gallery and a boat-shaped cap, four lattice sails turning, and a
// gear train turning under a lean-to at its foot.

import {
  poly,
  polyKit,
  type BuildingSpec,
  type Ctx2D,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const {
  INK,
  SHAKE,
  accent,
  ao,
  barrel,
  boards,
  castShadow,
  crate,
  grain,
  hatch,
  ink,
  ivy,
  mix,
  moss,
  openDoor,
  parkMiller,
  plankDoor,
  sack,
  shingles,
  stones,
  tufts,
  wash,
  windowAt,
} = polyKit;

const GRAIN_BOX = [-200, -380, 210, 55] as const;
const OLD_STONE = ["#8d8676", "#c9c1ad", "#7c8a5a"] as const;
const HUB = { x: 0, y: -196 } as const;
const H = 176;

/** A gear of radius R with n teeth, at (x, y), turned by a. */
function gear(g: Ctx2D, x: number, y: number, R: number, n: number, a: number) {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.fillStyle = "#8a7254";
  g.beginPath();
  for (let k = 0; k < n * 2; k++) {
    const aa = (k / (n * 2)) * 6.283;
    const rr = k % 2 ? R : R * 0.8;
    g.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
  }
  g.closePath();
  g.fill();
  ink(g, 0.9, 0.8);
  g.strokeStyle = "#5e4b36";
  g.lineWidth = 1.6;
  for (let k = 0; k < 4; k++) {
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(k * 1.57) * R * 0.7, Math.sin(k * 1.57) * R * 0.7);
    g.stroke();
  }
  g.fillStyle = "#3a332c";
  g.beginPath();
  g.arc(0, 0, R * 0.18, 0, 7);
  g.fill();
  g.restore();
}

export const windmill: BuildingSpec = {
  footprint: {
    w: 120,
    depth: 62,
    ground: [-139, -112, 181, 46],
    upper: [-158, -354, 158, -112],
  },
  setting: ["hill"],
  signX: -112,
  lights: [
    [0, -34, 20],
    [0, -100, 14],
    [0, -150, 12],
  ],
  paint(g, s) {
    const r = s.rnd;
    const acc = accent(s.hue, 0.15);
    castShadow(g, [
      [-46, 2],
      [150, 10],
      [180, -30],
      [60, -60],
    ]);
    // the tapering stone tower
    const tower: Pt[] = [
      [-48, 0],
      [48, 0],
      [32, -H],
      [-32, -H],
    ];
    const side: Pt[] = [
      [48, 0],
      [62, -10],
      [44, -H - 9],
      [32, -H],
    ];
    stones(g, tower, r, undefined, 10);
    wash(g, tower, "rgba(0,0,0,0)", OLD_STONE, r, 26, 14);
    const tg = g.createLinearGradient(-48, 0, 48, 0);
    tg.addColorStop(0, "rgba(255,250,235,.12)");
    tg.addColorStop(0.55, "rgba(0,0,0,0)");
    tg.addColorStop(1, "rgba(30,24,16,.3)");
    g.fillStyle = tg;
    poly(g, tower);
    g.fill();
    stones(g, side, r, undefined, 10);
    g.fillStyle = "rgba(30,26,20,.4)";
    poly(g, side);
    g.fill();
    hatch(g, side, r, 3);
    poly(g, side);
    ink(g, 1.1);
    poly(g, tower);
    ink(g, 1.4);
    // a wooden gallery round the tower
    const gal: Pt[] = [
      [-48, -112],
      [52, -112],
      [58, -120],
      [-42, -120],
    ];
    boards(g, gal, r, ["#7b6549", "#8a7254"], 6);
    poly(g, gal);
    ink(g, 1);
    g.strokeStyle = "#5e4b36";
    g.lineWidth = 1.6;
    for (let x = -46; x <= 54; x += 10) {
      g.beginPath();
      g.moveTo(x, -114);
      g.lineTo(x + 2, -132);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-46, -132);
    g.lineTo(56, -132);
    g.stroke();
    windowAt(g, -6, -96, 12, 16, s, { panes: 1 });
    windowAt(g, -5, -158, 10, 14, s, { panes: 1 });
    // the boat-shaped cap, shingled, its ridge in the accent
    shingles(
      g,
      [
        [-40, -H + 2],
        [44, -H + 2],
        [38, -H - 28],
        [8, -H - 44],
        [-30, -H - 28],
      ],
      r,
      SHAKE,
      6,
      8,
    );
    g.strokeStyle = acc;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(-30, -H - 28);
    g.quadraticCurveTo(8, -H - 50, 38, -H - 28);
    g.stroke();
    g.strokeStyle = INK;
    g.lineWidth = 0.8;
    g.stroke();
    g.fillStyle = "#4e3e2c";
    g.fillRect(-42, -H, 88, 5); // curb
    plankDoor(g, 0, 0, 24, 42, mix(acc, "#5e4b36", 0.4), r);
    moss(g, -48, 48, 0, r);
    tufts(g, -90, 110, 2, r, 22);
    ao(g, -48, 62, 2);
    ivy(g, -42, -2, 50, r);
    // the lean-to at the foot (right) the gear train turns under
    g.save();
    g.translate(78, 0);
    const lt: Pt[] = [
      [-18, 0],
      [40, 0],
      [40, -40],
      [-18, -50],
    ];
    boards(g, lt, r, ["#6e5a42", "#7b6549"], 7);
    g.fillStyle = "rgba(20,14,8,.5)";
    poly(g, lt);
    g.fill();
    poly(g, lt);
    ink(g, 1);
    shingles(
      g,
      [
        [-24, -46],
        [46, -36],
        [40, -60],
        [-20, -70],
      ],
      r,
      SHAKE,
      6,
      8,
    );
    g.restore();
    // sacks, a crate and a barrel
    sack(g, -70, 26);
    sack(g, -56, 30);
    sack(g, -64, 16);
    crate(g, -112, 36, 16);
    barrel(g, 150, 40);
    // the windshaft's hub mount
    g.fillStyle = "#3a332c";
    g.beginPath();
    g.ellipse(HUB.x, HUB.y, 9, 7, 0, 0, 7);
    g.fill();
    grain(g, GRAIN_BOX, parkMiller(1055));
  },
  animate(g, s) {
    // the gears at the foot, turning
    gear(g, 88, -22, 15, 12, s.t * 0.4);
    gear(g, 108, -10, 9, 8, -s.t * 0.67);
    // four lattice sails with weathered canvas
    g.save();
    g.translate(HUB.x, HUB.y);
    g.rotate(s.t * 0.45);
    for (let i = 0; i < 4; i++) {
      g.rotate(Math.PI / 2);
      g.fillStyle = "#5e4b36";
      g.fillRect(-2.5, 6, 5, 150);
      const cv: Pt[] = [
        [4, 26],
        [26, 26],
        [26, 150],
        [4, 150],
      ];
      poly(g, cv);
      const cg = g.createLinearGradient(4, 0, 26, 0);
      cg.addColorStop(0, "rgba(226,214,186,.95)");
      cg.addColorStop(1, "rgba(196,182,150,.95)");
      g.fillStyle = cg;
      g.fill();
      g.fillStyle = "rgba(140,120,80,.25)";
      g.fillRect(4, 26 + ((i * 37) % 90), 22, 18);
      g.strokeStyle = "#6e5a42";
      g.lineWidth = 1.2;
      for (let y = 26; y <= 150; y += 15.5) {
        g.beginPath();
        g.moveTo(4, y);
        g.lineTo(26, y);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(15, 26);
      g.lineTo(15, 150);
      g.stroke();
      poly(g, cv);
      ink(g, 1, 0.75);
      g.fillStyle = "#5e4b36";
      g.fillRect(-2.5, 6, 5, 150);
      g.beginPath();
      g.rect(-2.5, 6, 5, 150);
      ink(g, 0.8, 0.8);
    }
    g.fillStyle = "#4e3e2c";
    g.beginPath();
    g.arc(0, 0, 10, 0, 7);
    g.fill();
    ink(g, 1);
    g.fillStyle = "#8a6a32";
    g.beginPath();
    g.arc(0, 0, 4, 0, 7);
    g.fill();
    g.restore();
    if (s.open) openDoor(g, 0, 0, 24, 42);
  },
};
