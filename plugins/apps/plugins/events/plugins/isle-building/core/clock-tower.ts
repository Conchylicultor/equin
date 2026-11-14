// Events' building on Isle: the clock tower — a tall stone tower whose clock
// shows the real time, a bell swinging in the belfry, a pennant on the finial,
// and a notice board of pinned papers by the door.

import {
  poly,
  polyKit,
  type BuildingSpec,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const {
  SLATE,
  accent,
  ao,
  barrel,
  boards,
  castShadow,
  grain,
  hatch,
  ink,
  ivy,
  mix,
  moss,
  openDoor,
  parkMiller,
  plankDoor,
  rocks,
  shingles,
  stones,
  tufts,
  wash,
  windowAt,
} = polyKit;

const GRAIN_BOX = [-130, -390, 140, 50] as const;
const CLOCK = { x: 4, y: -186, r: 21 } as const;
const H = 236;
const OLD_STONE = ["#8d8676", "#c9c1ad", "#7c8a5a"] as const;
const PAPER = ["#efe4c8", "#e3d6b4", "#f4ecd6"] as const;

export const clockTower: BuildingSpec = {
  footprint: {
    w: 120,
    depth: 56,
    ground: [-117, -112, 205, 34],
    upper: [-46, -364, 82, -112],
  },
  setting: ["square"],
  signX: -105,
  lights: [
    [0, -30, 22],
    [4, -186, 26],
    [4, -122, 14],
  ],
  paint(g, s) {
    const r = s.rnd;
    const acc = accent(s.hue, 0.25);
    const W = 76;
    const sd = 16;
    castShadow(g, [
      [-W / 2 + 8, 2],
      [W / 2 + sd + 120, 10],
      [W / 2 + sd + 150, -40],
      [W / 2 + sd, -60],
    ]);
    // a low lean-to at the foot, so the tower sits in the village
    const lean: Pt[] = [
      [-60, 0],
      [-W / 2, 0],
      [-W / 2, -46],
      [-60, -40],
    ];
    stones(g, lean, r);
    poly(g, lean);
    ink(g, 1);
    shingles(
      g,
      [
        [-66, -36],
        [-W / 2, -44],
        [-W / 2, -66],
        [-62, -56],
      ],
      r,
      SLATE,
      6,
      9,
    );
    const front: Pt[] = [
      [-W / 2, 0],
      [W / 2, 0],
      [W / 2 - 3, -H],
      [-W / 2 + 3, -H],
    ];
    const side: Pt[] = [
      [W / 2, 0],
      [W / 2 + sd, -11],
      [W / 2 + sd - 3, -H - 11],
      [W / 2 - 3, -H],
    ];
    stones(g, front, r, undefined, 10);
    wash(g, front, "rgba(0,0,0,0)", OLD_STONE, r, 30, 14);
    stones(g, side, r, undefined, 10);
    poly(g, side);
    g.fillStyle = "rgba(30,26,20,.35)";
    g.fill();
    hatch(g, side, r, 3);
    // quoins and string courses
    for (let y = 0; y > -H; y -= 14) {
      const odd = (y / 14) % 2;
      for (const [qx, qw] of [
        [-W / 2, odd ? 14 : 9],
        [W / 2 - (odd ? 9 : 14), odd ? 9 : 14],
      ] as const) {
        g.fillStyle = "#cbc4b2";
        g.fillRect(qx, y - 13, qw, 12);
        g.strokeStyle = "rgba(48,38,28,.5)";
        g.lineWidth = 0.8;
        g.strokeRect(qx, y - 13, qw, 12);
      }
    }
    for (const y of [-96, -150]) {
      g.fillStyle = "#c3bba7";
      g.fillRect(-W / 2 - 3, y, W + 6, 5);
      g.beginPath();
      g.rect(-W / 2 - 3, y, W + 6, 5);
      ink(g, 0.9);
    }
    poly(g, front);
    ink(g, 1.4);
    poly(g, side);
    ink(g, 1.2);
    // the clock face (the hands are animated: they show the real time)
    g.fillStyle = "#8a8272";
    g.beginPath();
    g.arc(CLOCK.x, CLOCK.y, CLOCK.r + 5, 0, 7);
    g.fill();
    ink(g, 1.1);
    g.fillStyle = "#e9dfc4";
    g.beginPath();
    g.arc(CLOCK.x, CLOCK.y, CLOCK.r, 0, 7);
    g.fill();
    wash(
      g,
      Array.from({ length: 16 }, (_, k): Pt => [
        CLOCK.x + Math.cos((k / 16) * 6.28) * CLOCK.r,
        CLOCK.y + Math.sin((k / 16) * 6.28) * CLOCK.r,
      ]),
      "rgba(0,0,0,0)",
      ["#c9bb98", "#f3ead2"],
      r,
      10,
      6,
    );
    g.strokeStyle = "#3a2e22";
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 6.28;
      const l = k % 3 ? 3 : 6;
      g.lineWidth = k % 3 ? 1 : 2;
      g.beginPath();
      g.moveTo(
        CLOCK.x + Math.cos(a) * (CLOCK.r - 2),
        CLOCK.y + Math.sin(a) * (CLOCK.r - 2),
      );
      g.lineTo(
        CLOCK.x + Math.cos(a) * (CLOCK.r - 2 - l),
        CLOCK.y + Math.sin(a) * (CLOCK.r - 2 - l),
      );
      g.stroke();
    }
    g.beginPath();
    g.arc(CLOCK.x, CLOCK.y, CLOCK.r, 0, 7);
    ink(g, 1.2);
    windowAt(g, -6, -134, 12, 22, s, { arch: true, panes: 1 });
    windowAt(g, -6, -76, 12, 20, s, { arch: true, panes: 1 });
    // the belfry: open arches with the bell, a small slate pyramid roof
    const bT = -H - 50;
    const bel: Pt[] = [
      [-W / 2 + 4, -H],
      [W / 2 - 4, -H],
      [W / 2 - 4, bT],
      [-W / 2 + 4, bT],
    ];
    stones(g, bel, r);
    poly(g, bel);
    ink(g, 1.2);
    g.fillStyle = "#1e1a16";
    g.beginPath();
    g.moveTo(-18, -H - 4);
    g.lineTo(-18, -H - 30);
    g.arc(0, -H - 30, 18, Math.PI, 0);
    g.lineTo(18, -H - 4);
    g.closePath();
    g.fill();
    ink(g, 1);
    g.fillStyle = "#3a3633";
    g.fillRect(-W / 2 + 2, -H - 4, W - 4, 5);
    const bs: Pt[] = [
      [W / 2 - 4, -H],
      [W / 2 + sd - 6, -H - 11],
      [W / 2 + sd - 6, bT - 11],
      [W / 2 - 4, bT],
    ];
    stones(g, bs, r);
    g.fillStyle = "rgba(30,26,20,.38)";
    poly(g, bs);
    g.fill();
    poly(g, bs);
    ink(g, 1);
    const roof: Pt[] = [
      [-W / 2 - 6, bT + 3],
      [W / 2 + 6, bT + 3],
      [8, bT - 54],
    ];
    const roofS: Pt[] = [
      [W / 2 + 6, bT + 3],
      [W / 2 + sd + 2, bT - 9],
      [8, bT - 54],
    ];
    shingles(g, roof, r, SLATE, 6, 8);
    poly(g, roofS);
    g.fillStyle = "#4b4f55";
    g.fill();
    hatch(g, roofS, r, 3, 0.25);
    ink(g, 1.1);
    // the pennant's mast on the finial (the pennant is animated)
    g.strokeStyle = "#3a332c";
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(8, bT - 54);
    g.lineTo(8, bT - 76);
    g.stroke();
    // a notice board with pinned papers, right of the door
    g.save();
    g.translate(56, 14);
    g.fillStyle = "rgba(44,46,24,.25)";
    g.fillRect(-4, 0, 50, 6);
    g.fillStyle = "#5e4b36";
    g.fillRect(0, -40, 4, 40);
    g.fillRect(38, -40, 4, 40);
    const nb: Pt[] = [
      [-2, -60],
      [44, -60],
      [44, -30],
      [-2, -30],
    ];
    boards(g, nb, r, ["#7b6549", "#8a7254"], 7);
    poly(g, nb);
    ink(g, 1.1);
    g.fillStyle = "#5e4b36";
    poly(g, [
      [-6, -60],
      [48, -60],
      [42, -68],
      [0, -68],
    ]);
    g.fill();
    ink(g, 0.9);
    for (let k = 0; k < 6; k++) {
      const px = 1 + (k % 3) * 14 + r() * 2;
      const py = -57 + ((k / 3) | 0) * 13 + r() * 2;
      g.save();
      g.translate(px + 5, py + 5);
      g.rotate((r() - 0.5) * 0.3);
      g.fillStyle = k === 2 ? mix(acc, "#efe4c8", 0.45) : PAPER[k % 3]!;
      g.fillRect(-5, -5, 11, 11);
      g.strokeStyle = "rgba(60,50,40,.55)";
      g.lineWidth = 0.6;
      for (let l = -2; l < 4; l += 2) {
        g.beginPath();
        g.moveTo(-3, l);
        g.lineTo(3 + r() * 2, l);
        g.stroke();
      }
      g.fillStyle = "#8a3a2a";
      g.fillRect(-0.8, -5, 1.6, 1.6);
      g.restore();
    }
    g.restore();
    plankDoor(g, 0, 0, 24, 40, "#5e4b36", r);
    moss(g, -W / 2, W / 2, 0, r);
    tufts(g, -70, 60, 2, r, 18);
    ao(g, -60, W / 2 + sd, 2);
    ivy(g, -W / 2 + 6, -2, 90, r);
    ivy(g, W / 2 - 8, -2, 50, r);
    rocks(g, -100, 30, r, 2);
    barrel(g, -46, 28);
    grain(g, GRAIN_BOX, parkMiller(793));
  },
  animate(g, s) {
    // the hands show the real time
    const d = new Date();
    const hr = (d.getHours() % 12) + d.getMinutes() / 60;
    const mn = d.getMinutes() + d.getSeconds() / 60;
    g.strokeStyle = "#2a221a";
    g.lineCap = "round";
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(CLOCK.x, CLOCK.y);
    g.lineTo(
      CLOCK.x + Math.sin((hr / 12) * 6.283) * 10,
      CLOCK.y - Math.cos((hr / 12) * 6.283) * 10,
    );
    g.stroke();
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(CLOCK.x, CLOCK.y);
    g.lineTo(
      CLOCK.x + Math.sin((mn / 60) * 6.283) * 16,
      CLOCK.y - Math.cos((mn / 60) * 6.283) * 16,
    );
    g.stroke();
    g.fillStyle = "#2a221a";
    g.beginPath();
    g.arc(CLOCK.x, CLOCK.y, 2, 0, 7);
    g.fill();
    // the bell, swinging a little
    const a = Math.sin(s.t * 1.3) * 0.12;
    g.save();
    g.translate(0, -H - 44);
    g.rotate(a);
    g.fillStyle = "#3a3633";
    g.fillRect(-1, 0, 2, 6);
    const gr = g.createLinearGradient(-11, 0, 11, 0);
    gr.addColorStop(0, "#8a6a32");
    gr.addColorStop(0.35, "#c79a4a");
    gr.addColorStop(1, "#5e4620");
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(-6, 6);
    g.quadraticCurveTo(-7, 18, -12, 24);
    g.lineTo(12, 24);
    g.quadraticCurveTo(7, 18, 6, 6);
    g.closePath();
    g.fill();
    ink(g, 1);
    g.restore();
    // the pennant
    const bT = -H - 50 - 54;
    g.fillStyle = accent(s.hue, 0.2);
    g.beginPath();
    g.moveTo(8, bT - 22);
    g.quadraticCurveTo(
      18,
      bT - 20 + Math.sin(s.t * 3) * 2,
      26,
      bT - 17 + Math.sin(s.t * 3 + 1) * 3,
    );
    g.lineTo(8, bT - 12);
    g.closePath();
    g.fill();
    ink(g, 0.8, 0.7);
    if (s.open) openDoor(g, 0, 0, 24, 40);
  },
};
