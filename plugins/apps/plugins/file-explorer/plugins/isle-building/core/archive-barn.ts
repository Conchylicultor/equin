// The File Explorer's building on Isle: the archive barn — a timber storehouse
// on a stone base, its double doors swung open on shelves of boxes and scrolls,
// a hay-loft hoist, crates and a hand cart of sacks.

import {
  poly,
  polyKit,
  type BuildingSpec,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const {
  INK,
  SHAKE,
  accent,
  ao,
  barrel,
  boards,
  box,
  crate,
  grain,
  ink,
  ivy,
  mix,
  moss,
  parkMiller,
  rocks,
  sack,
  shingles,
  stones,
  tufts,
  windowAt,
} = polyKit;

const GRAIN_BOX = [-170, -215, 175, 50] as const;
const SHELF = ["#8e7a58", "#a08a64", "#6f6048"] as const;

export const archiveBarn: BuildingSpec = {
  footprint: {
    w: 210,
    depth: 80,
    ground: [-152, -112, 178, 45],
    upper: [-106, -189, 128, -112],
  },
  setting: ["harbour", "shore"],
  signX: -150,
  lights: [
    [0, -36, 28],
    [-60, -66, 14],
    [60, -66, 14],
  ],
  paint(g, s) {
    const r = s.rnd;
    const acc = accent(s.hue, 0.25);
    // timber walls under a shake roof
    const geo = box(g, r, {
      W: 190,
      h: 112,
      rd: 74,
      sd: 22,
      wall: (g2, pts) =>
        boards(
          g2,
          pts,
          r,
          ["#8a7254", "#7b6549", "#9c845f", "#6e5a42", "#857057"],
          10,
        ),
      roof: (g2, pts) => shingles(g2, pts, r, SHAKE, 7, 11),
    });
    // stone base course across the front + side
    const base: Pt[] = [
      [geo.L, 0],
      [geo.R, 0],
      [geo.R, -22],
      [geo.L, -22],
    ];
    stones(g, base, r);
    poly(g, base);
    ink(g, 1.1);
    const sb: Pt[] = [
      [geo.R, 0],
      [geo.R + 22, -15],
      [geo.R + 22, -37],
      [geo.R, -22],
    ];
    stones(g, sb, r);
    g.fillStyle = "rgba(30,26,20,.35)";
    poly(g, sb);
    g.fill();
    poly(g, sb);
    ink(g, 1);
    // timber frame posts and a rail
    g.fillStyle = "#5e4b36";
    for (const px of [geo.L, -48, 48, geo.R - 6]) {
      g.fillRect(px, -112, 6, 90);
      g.beginPath();
      g.rect(px, -112, 6, 90);
      ink(g, 0.8, 0.6);
    }
    g.fillRect(geo.L, -84, 190, 5);
    // the double doors, ajar: shelves of boxes and scrolls inside
    const dw = 62;
    const dh = 70;
    g.fillStyle = "#2b2219";
    g.fillRect(-dw / 2, -dh, dw, dh);
    for (let k = 0; k < 4; k++) {
      const sy = -dh + 10 + k * 16;
      g.fillStyle = "#5a4632";
      g.fillRect(-dw / 2 + 4, sy + 10, dw - 8, 2.5);
      for (let x = -dw / 2 + 6; x < dw / 2 - 8; x += 7 + r() * 4) {
        if (r() < 0.5) {
          g.fillStyle = [...SHELF, acc][(r() * 4) | 0]!;
          g.fillRect(x, sy + 2, 6, 8);
          g.globalAlpha = 0.5;
          g.strokeStyle = INK;
          g.lineWidth = 0.6;
          g.strokeRect(x, sy + 2, 6, 8);
          g.globalAlpha = 1;
        } else {
          g.fillStyle = "#e3d6b4";
          g.beginPath();
          g.ellipse(x + 3, sy + 7, 3.4, 2.6, 0, 0, 7);
          g.fill();
          g.strokeStyle = "rgba(90,70,40,.7)";
          g.lineWidth = 0.7;
          g.stroke();
        }
      }
    }
    g.fillStyle = s.night ? "rgba(255,190,100,.28)" : "rgba(0,0,0,.25)";
    g.fillRect(-dw / 2, -dh, dw, dh);
    // door leaves swung outward, X-braced, painted in the accent
    for (const [hx, dir] of [
      [-dw / 2, -1],
      [dw / 2, 1],
    ] as const) {
      const lw = 30;
      const pts: Pt[] = [
        [hx, 0],
        [hx + dir * lw * 0.55, 6],
        [hx + dir * lw * 0.55, -dh + 4],
        [hx, -dh],
      ];
      boards(
        g,
        pts,
        r,
        [acc, mix(acc, "#3a2e22", 0.25), mix(acc, "#6e5a42", 0.4)],
        6,
      );
      g.fillStyle = "rgba(20,14,8,.2)";
      poly(g, pts);
      g.fill();
      g.strokeStyle = "#4a3a2a";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(pts[0]![0], pts[0]![1] - 4);
      g.lineTo(pts[2]![0], pts[2]![1] + 4);
      g.moveTo(pts[1]![0], pts[1]![1] - 4);
      g.lineTo(pts[3]![0], pts[3]![1] + 4);
      g.stroke();
      poly(g, pts);
      ink(g, 1);
    }
    g.beginPath();
    g.rect(-dw / 2, -dh, dw, dh);
    ink(g, 1.4);
    // the hay-loft door, and the hoist beam above it
    g.fillStyle = "#4a3a2a";
    g.fillRect(-14, -108, 28, 22);
    boards(
      g,
      [
        [-12, -88],
        [12, -88],
        [12, -106],
        [-12, -106],
      ],
      r,
      ["#6e5a42", "#7b6549"],
      6,
    );
    g.beginPath();
    g.rect(-14, -108, 28, 22);
    ink(g, 1);
    g.fillStyle = "#5e4b36";
    g.fillRect(-4, -130, 8, 24);
    g.fillRect(-4, -134, 30, 6);
    g.strokeStyle = "#6b5a40";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(22, -128);
    g.lineTo(22, -96);
    g.stroke();
    g.fillStyle = "#3a332c";
    g.beginPath();
    g.arc(22, -130, 3, 0, 7);
    g.fill();
    sack(g, 22, -82);
    windowAt(g, -76, -70, 14, 16, s, { panes: 1 });
    windowAt(g, 62, -70, 14, 16, s, { panes: 1 });
    // weathering
    moss(g, geo.L, geo.R, 0, r);
    tufts(g, geo.L - 10, geo.R + 20, 2, r, 22);
    ao(g, geo.L, geo.R + 22, 2);
    ivy(g, geo.L + 4, -2, 60, r);
    // props: crates, a barrel, a hand cart with sacks
    crate(g, -150, 30, 18);
    crate(g, -132, 30, 16);
    crate(g, -146, 12, 15);
    barrel(g, -112, 34);
    g.save();
    g.translate(108, 34);
    g.fillStyle = "rgba(44,46,24,.25)";
    g.beginPath();
    g.ellipse(14, 2, 34, 7, 0, 0, 7);
    g.fill();
    const bed: Pt[] = [
      [-24, -8],
      [28, -8],
      [28, -22],
      [-24, -22],
    ];
    boards(g, bed, r, ["#8a7254", "#9c845f"], 7);
    poly(g, bed);
    ink(g, 1);
    sack(g, -10, -20);
    sack(g, 8, -21);
    sack(g, 0, -30);
    g.strokeStyle = "#5e4b36";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(28, -14);
    g.lineTo(52, -4);
    g.stroke();
    g.fillStyle = "#6e5a42";
    g.beginPath();
    g.arc(-2, -4, 10, 0, 7);
    g.fill();
    ink(g, 1.2);
    g.strokeStyle = "#4a3a2a";
    g.lineWidth = 1.2;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * 6.28;
      g.beginPath();
      g.moveTo(-2, -4);
      g.lineTo(-2 + Math.cos(a) * 9, -4 + Math.sin(a) * 9);
      g.stroke();
    }
    g.restore();
    rocks(g, 150, 40, r, 2);
    grain(g, GRAIN_BOX, parkMiller(662));
  },
  animate(g, s) {
    if (!s.open) return;
    const sp = g.createLinearGradient(0, 0, 0, 24);
    sp.addColorStop(0, "rgba(255,200,120,.45)");
    sp.addColorStop(1, "rgba(255,200,120,0)");
    g.fillStyle = sp;
    g.beginPath();
    g.moveTo(-31, 0);
    g.lineTo(31, 0);
    g.lineTo(42, 24);
    g.lineTo(-42, 24);
    g.fill();
    g.fillStyle = "rgba(255,190,100,.22)";
    g.fillRect(-31, -70, 62, 70);
  },
};
