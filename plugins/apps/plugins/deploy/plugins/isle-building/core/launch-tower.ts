// Deploy's building on Isle: the timber launch tower — X-braced legs with a
// ladder and a railed top platform, a riveted brass-nosed rocket held by its
// arms (steam venting at its foot), a control shed with dials in front, a
// winch roping up to the top, and a beacon blinking on the tower.

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
  castShadow,
  courseWall,
  crate,
  grain,
  ink,
  mix,
  moss,
  openDoor,
  parkMiller,
  plankDoor,
  rocks,
  shingles,
  steam,
  stones,
  tufts,
  windowAt,
} = polyKit;

const GRAIN_BOX = [-170, -360, 190, 55] as const;
/** The tower's two legs: [x at the foot, y at the foot, x at the top, y at the top]. */
const LEGS = [
  [22, -88, 32, -330],
  [118, -88, 104, -330],
] as const;

export const launchTower: BuildingSpec = {
  footprint: {
    w: 200,
    depth: 88,
    ground: [-132, -112, 191, 51],
    upper: [-83, -375, 148, -112],
  },
  setting: ["cape", "coast"],
  signX: -150,
  lights: [
    [0, -26, 18],
    [54, -306, 16],
    [-30, -40, 12],
  ],
  paint(g, s) {
    const r = s.rnd;
    const acc = accent(s.hue, 0.25);
    castShadow(g, [
      [-90, 4],
      [180, 12],
      [190, -20],
      [110, -60],
      [-40, -30],
    ]);
    // the stone launch pad behind
    const pad: Pt[] = [
      [-10, -70],
      [130, -70],
      [146, -112],
      [6, -112],
    ];
    stones(g, pad, r, ["#a9a397", "#968f82", "#b7b0a2"], 10);
    poly(g, pad);
    ink(g, 1.1);
    g.fillStyle = "rgba(30,24,16,.4)";
    g.beginPath();
    g.ellipse(70, -92, 34, 9, 0, 0, 7);
    g.fill(); // scorch
    // the tower: two tapering timber legs with X-braces, a platform and a ladder
    const beam = (x1: number, y1: number, x2: number, y2: number, w = 5) => {
      g.strokeStyle = "#5e4b36";
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.strokeStyle = "rgba(240,225,190,.18)";
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x1 - 1, y1);
      g.lineTo(x2 - 1, y2);
      g.stroke();
      g.strokeStyle = INK;
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(x1 + w / 2, y1);
      g.lineTo(x2 + w / 2, y2);
      g.stroke();
    };
    const lx = (y: number, i: 0 | 1) => {
      const L = LEGS[i];
      return L[0] + ((L[2] - L[0]) * (y + 88)) / (-330 + 88);
    };
    for (let y = -88; y > -320; y -= 56) {
      const y2 = y - 56;
      beam(lx(y, 0), y, lx(y2, 1), y2, 3);
      beam(lx(y, 1), y, lx(y2, 0), y2, 3);
      beam(lx(y, 0), y, lx(y, 1), y, 4);
    }
    for (const [x1, y1, x2, y2] of LEGS) beam(x1, y1, x2, y2, 7);
    // the platform at the top, with a railing
    const top: Pt[] = [
      [24, -322],
      [112, -322],
      [116, -334],
      [28, -334],
    ];
    boards(g, top, r, ["#7b6549", "#8a7254"], 6);
    poly(g, top);
    ink(g, 1);
    g.strokeStyle = "#5e4b36";
    g.lineWidth = 2;
    for (let x = 28; x <= 112; x += 14) {
      g.beginPath();
      g.moveTo(x, -334);
      g.lineTo(x, -350);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(26, -350);
    g.lineTo(114, -350);
    g.stroke();
    // a ladder up the left leg
    g.strokeStyle = "#6e5a42";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(8, -88);
    g.lineTo(18, -330);
    g.moveTo(18, -88);
    g.lineTo(26, -330);
    g.stroke();
    for (let y = -92; y > -330; y -= 9) {
      const t = (y + 88) / -242;
      g.beginPath();
      g.moveTo(8 + 10 * t, y);
      g.lineTo(18 + 8 * t, y);
      g.stroke();
    }
    // the rocket: riveted brass nose, wooden body with copper bands, fins, accent stripe
    g.save();
    g.translate(70, -100);
    const body: Pt[] = [
      [-15, 0],
      [15, 0],
      [16, -150],
      [-16, -150],
    ];
    boards(g, body, r, ["#9c845f", "#8a7254", "#a88f68"], 6);
    const shade = g.createLinearGradient(-16, 0, 16, 0);
    shade.addColorStop(0, "rgba(255,240,210,.15)");
    shade.addColorStop(0.5, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(30,20,10,.4)");
    g.fillStyle = shade;
    poly(g, body);
    g.fill();
    poly(g, body);
    ink(g, 1.3);
    for (const by of [-12, -60, -110]) {
      const bg = g.createLinearGradient(-16, 0, 16, 0);
      bg.addColorStop(0, "#c08a50");
      bg.addColorStop(0.4, "#e0b070");
      bg.addColorStop(1, "#7a4e28");
      g.fillStyle = bg;
      g.fillRect(-17, by - 6, 34, 6);
      g.fillStyle = "#5a3a1c";
      for (let k = -13; k < 15; k += 5) g.fillRect(k, by - 4, 1.4, 1.4);
      g.beginPath();
      g.rect(-17, by - 6, 34, 6);
      ink(g, 0.9);
    }
    g.fillStyle = acc;
    g.fillRect(-16, -90, 32, 14);
    g.fillStyle = "rgba(0,0,0,.22)";
    g.fillRect(4, -90, 12, 14);
    g.beginPath();
    g.rect(-16, -90, 32, 14);
    ink(g, 0.9);
    g.fillStyle = "#2e2a26";
    g.beginPath();
    g.arc(0, -128, 6, 0, 7);
    g.fill();
    g.fillStyle = "#e0b070";
    g.beginPath();
    g.arc(0, -128, 6, 0, 7);
    g.lineWidth = 2;
    g.strokeStyle = "#b08040";
    g.stroke();
    g.fillStyle = "#6b8a8c";
    g.beginPath();
    g.arc(0, -128, 4, 0, 7);
    g.fill();
    const nose = g.createLinearGradient(-16, 0, 16, 0);
    nose.addColorStop(0, "#b8863e");
    nose.addColorStop(0.35, "#e8c27a");
    nose.addColorStop(1, "#6e4a1e");
    g.fillStyle = nose;
    g.beginPath();
    g.moveTo(-16, -150);
    g.quadraticCurveTo(-14, -190, 0, -214);
    g.quadraticCurveTo(14, -190, 16, -150);
    g.closePath();
    g.fill();
    ink(g, 1.3);
    g.fillStyle = "#5a3a1c";
    for (let k = 0; k < 7; k++) g.fillRect(-13 + k * 4.3, -153, 1.4, 1.4);
    for (const d of [-1, 1]) {
      g.fillStyle = "#7b6549";
      g.beginPath();
      g.moveTo(d * 15, -6);
      g.lineTo(d * 15, -44);
      g.lineTo(d * 30, -4);
      g.lineTo(d * 30, 6);
      g.closePath();
      g.fill();
      ink(g, 1.1);
    }
    g.fillStyle = "#3a332c";
    g.fillRect(-10, 0, 20, 6);
    g.restore();
    // the tower arms holding the rocket
    beam(lx(-200, 1), -200, 86, -200, 4);
    beam(lx(-260, 0), -260, 54, -260, 4);
    // the control shed in front, with the door
    box(g, r, {
      W: 96,
      h: 58,
      rd: 40,
      sd: 14,
      wall: courseWall(r, ["#8a7254", "#7b6549", "#937a58"]),
      roof: (g2, p) => shingles(g2, p, r, SHAKE, 6, 9),
    });
    windowAt(g, -40, -46, 14, 14, s, { panes: 2 });
    plankDoor(g, 0, 0, 22, 38, "#5e4b36", r, false);
    // dials on a panel by the window, warning chevrons on the base
    g.fillStyle = "#3a3633";
    g.fillRect(22, -46, 20, 14);
    for (const [dx, dy] of [
      [27, -39],
      [37, -39],
    ] as const) {
      g.fillStyle = "#e3d6b4";
      g.beginPath();
      g.arc(dx, dy, 3.6, 0, 7);
      g.fill();
      g.strokeStyle = "#3a2e22";
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(dx, dy);
      g.lineTo(dx + 2, dy - 2);
      g.stroke();
    }
    g.save();
    g.beginPath();
    g.rect(-48, -8, 96, 8);
    g.clip();
    for (let x = -60; x < 60; x += 10) {
      g.fillStyle = (x / 10) % 2 ? "#3a332c" : mix(acc, "#c9a24a", 0.5);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 5, 0);
      g.lineTo(x + 13, -8);
      g.lineTo(x + 8, -8);
      g.fill();
    }
    g.restore();
    moss(g, -48, 48, 0, r);
    tufts(g, -90, 120, 2, r, 22);
    ao(g, -48, 62, 2);
    // a winch with a rope running up to the tower
    g.save();
    g.translate(-82, 26);
    g.fillStyle = "rgba(44,46,24,.25)";
    g.beginPath();
    g.ellipse(6, 2, 22, 5, 0, 0, 7);
    g.fill();
    g.fillStyle = "#5e4b36";
    g.fillRect(-14, -24, 5, 24);
    g.fillRect(12, -24, 5, 24);
    g.fillStyle = "#8a7254";
    g.beginPath();
    g.ellipse(1, -14, 12, 8, 0, 0, 7);
    g.fill();
    ink(g, 1);
    g.strokeStyle = "#c2ad84";
    g.lineWidth = 1;
    for (let k = -8; k < 10; k += 2.5) {
      g.beginPath();
      g.moveTo(k, -21);
      g.lineTo(k + 1, -7);
      g.stroke();
    }
    g.strokeStyle = "#3a332c";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(14, -14);
    g.lineTo(24, -26);
    g.lineTo(30, -24);
    g.stroke();
    g.restore();
    g.strokeStyle = "rgba(170,150,110,.9)";
    g.lineWidth = 1.1;
    g.beginPath();
    g.moveTo(-81, 12);
    g.quadraticCurveTo(-20, -60, 30, -322);
    g.stroke();
    barrel(g, -120, 40);
    barrel(g, -102, 44);
    crate(g, 120, 40, 18);
    rocks(g, 160, 46, r, 3);
    grain(g, GRAIN_BOX, parkMiller(793));
  },
  animate(g, s) {
    steam(g, 50, -96, s.t, 5, 1);
    steam(g, 92, -98, s.t + 1.7, 4, -1);
    // a beacon lantern blinking on the tower top
    const on = Math.sin(s.t * 2.4) > 0.2;
    g.fillStyle = on ? "#ffcf6a" : "#8a6a3a";
    g.beginPath();
    g.arc(70, -356, 4, 0, 7);
    g.fill();
    ink(g, 0.8, 0.8);
    if (on) {
      const gr = g.createRadialGradient(70, -356, 0, 70, -356, 18);
      gr.addColorStop(0, "rgba(255,210,120,.55)");
      gr.addColorStop(1, "rgba(255,210,120,0)");
      g.fillStyle = gr;
      g.fillRect(52, -374, 36, 36);
    }
    if (s.open) openDoor(g, 0, 0, 22, 38, false);
  },
};
