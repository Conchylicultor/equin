// Prototypes' building on Isle: the inventor's sketch cabin — a log cabin with
// blueprints pinned on its wall and a smoking stone chimney, a drawing table
// under a striped awning with sketches on a line, and a half-built contraption
// of wheels and gears.

import {
  poly,
  polyKit,
  type BuildingSpec,
  type Ctx2D,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const {
  SHAKE,
  accent,
  ao,
  boards,
  box,
  courseWall,
  crate,
  grain,
  ink,
  lantern,
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

const GRAIN_BOX = [-170, -190, 175, 55] as const;
const SHEETS = ["#efe4c8", "#e3d6b4", "#f4ecd6", "#e8dcbc"] as const;

function gear(g: Ctx2D, x: number, y: number, R: number, n: number): void {
  g.fillStyle = "#9a7a3a";
  g.beginPath();
  for (let k = 0; k < n * 2; k++) {
    const a = (k / (n * 2)) * 6.283;
    const rr = k % 2 ? R : R * 0.78;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  ink(g, 0.8, 0.8);
  g.fillStyle = "#3a332c";
  g.beginPath();
  g.arc(x, y, R * 0.25, 0, 7);
  g.fill();
}

export const inventorsCabin: BuildingSpec = {
  footprint: {
    w: 196,
    depth: 72,
    ground: [-152, -112, 174, 50],
    upper: [-74, -249, 92, -112],
  },
  setting: ["forest"],
  signX: -140,
  chimney: { x: 35, y: -156, puffs: 5 },
  lights: [
    [0, -30, 20],
    [-40, -50, 14],
    [88, -60, 16],
    [130, -60, 12],
  ],
  paint(g, s) {
    const r = s.rnd;
    const acc = accent(s.hue, 0.2);
    const geo = box(g, r, {
      W: 126,
      h: 76,
      rd: 58,
      sd: 18,
      wall: courseWall(r, ["#7b6549", "#8a7254", "#6e5a42", "#937a58"]),
      roof: (g2, p) => shingles(g2, p, r, SHAKE, 7, 10),
    });
    // a crooked stone chimney with a tin cowl
    const ch: Pt[] = [
      [28, -110],
      [42, -110],
      [42, -148],
      [28, -148],
    ];
    stones(g, ch, r);
    poly(g, ch);
    ink(g, 1);
    g.fillStyle = "#5a5650";
    g.fillRect(26, -154, 18, 6);
    windowAt(g, -46, -56, 18, 20, s, { panes: 2 });
    plankDoor(g, 0, 0, 24, 42, "#6e5a42", r, false);
    // blueprints pinned on the wall
    for (const [k, [bx, by, bw, bh]] of (
      [
        [22, -62, 22, 16],
        [46, -54, 14, 18],
      ] as const
    ).entries()) {
      g.save();
      g.translate(bx + bw / 2, by + bh / 2);
      g.rotate((r() - 0.5) * 0.12);
      g.fillStyle = k ? "#e8dcbc" : "#3f5f86";
      g.fillRect(-bw / 2, -bh / 2, bw, bh);
      g.strokeStyle = k ? "rgba(60,50,40,.7)" : "rgba(220,235,245,.8)";
      g.lineWidth = 0.7;
      g.beginPath();
      g.rect(-bw / 2 + 2, -bh / 2 + 2, bw - 4, bh - 4);
      g.moveTo(-bw / 2 + 4, 0);
      g.arc(0, 0, bh / 4, 0, 6.28);
      g.moveTo(-bw / 2 + 3, bh / 2 - 4);
      g.lineTo(bw / 2 - 3, -bh / 2 + 4);
      g.stroke();
      ink(g, 0.6, 0.6);
      g.restore();
    }
    moss(g, geo.L, geo.R, 0, r);
    tufts(g, -100, 160, 2, r, 22);
    ao(g, geo.L, geo.R + 18, 2);
    // the awning on poles over the drawing table (right)
    g.save();
    g.translate(112, 0);
    g.fillStyle = "rgba(44,46,24,.22)";
    g.beginPath();
    g.ellipse(10, 4, 50, 10, 0, 0, 7);
    g.fill();
    g.fillStyle = "#5e4b36";
    g.fillRect(-36, -78, 4, 78);
    g.fillRect(36, -78, 4, 78);
    const aw: Pt[] = [
      [-44, -76],
      [48, -76],
      [40, -110],
      [-36, -110],
    ];
    wash(
      g,
      aw,
      "#c8b88f",
      ["#b5a47a", "#d8c9a2", mix(acc, "#c8b88f", 0.5)],
      r,
      30,
      10,
    );
    g.save();
    poly(g, aw);
    g.clip();
    for (let x = -44; x < 50; x += 18) {
      g.fillStyle = mix(acc, "#c8b88f", 0.35);
      g.globalAlpha = 0.55;
      g.beginPath();
      g.moveTo(x, -76);
      g.lineTo(x + 9, -76);
      g.lineTo(x + 9 - 1.6, -110);
      g.lineTo(x - 1.6, -110);
      g.fill();
    }
    g.restore();
    g.globalAlpha = 1;
    poly(g, aw);
    ink(g, 1.1);
    for (let x = -44; x < 48; x += 9) {
      g.fillStyle = "#b5a47a";
      g.beginPath();
      g.moveTo(x, -76);
      g.lineTo(x + 9, -76);
      g.lineTo(x + 4.5, -70);
      g.fill();
      ink(g, 0.6, 0.5);
    }
    // the drawing table with sheets
    g.fillStyle = "#5e4b36";
    g.fillRect(-26, -22, 3, 22);
    g.fillRect(22, -22, 3, 22);
    g.fillRect(-28, -30, 3, 30);
    const tb: Pt[] = [
      [-30, -24],
      [30, -24],
      [24, -40],
      [-26, -44],
    ];
    boards(g, tb, r, ["#9c845f", "#8a7254"], 6);
    poly(g, tb);
    ink(g, 1);
    for (const [k, [px, py, a]] of (
      [
        [-20, -40, 0.1],
        [-2, -38, -0.08],
        [10, -36, 0.05],
      ] as const
    ).entries()) {
      g.save();
      g.translate(px, py);
      g.rotate(a);
      g.fillStyle = k === 1 ? "#3f5f86" : "#efe4c8";
      g.fillRect(0, 0, 16, 11);
      g.strokeStyle = k === 1 ? "rgba(220,235,245,.8)" : "rgba(60,50,40,.6)";
      g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(2, 3);
      g.lineTo(13, 3);
      g.moveTo(2, 6);
      g.lineTo(9, 6);
      g.arc(11, 7, 2.5, 0, 6.28);
      g.stroke();
      g.restore();
    }
    g.fillStyle = "#8a6c4a";
    g.fillRect(16, -46, 6, 6);
    g.strokeStyle = "#c9a24a";
    g.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(17 + k * 2, -46);
      g.lineTo(16 + k * 3, -54);
      g.stroke();
    }
    // sketches pinned on a line under the awning
    g.strokeStyle = "rgba(90,70,40,.8)";
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(-34, -68);
    g.quadraticCurveTo(0, -62, 36, -68);
    g.stroke();
    for (const [k, px] of [-24, -6, 12, 26].entries()) {
      g.fillStyle = SHEETS[k]!;
      g.fillRect(px - 5, -66, 10, 12);
      g.strokeStyle = "rgba(60,50,40,.55)";
      g.beginPath();
      g.moveTo(px - 3, -62);
      g.lineTo(px + 3, -58);
      g.moveTo(px - 2, -58);
      g.arc(px, -60, 2, 0, 6.28);
      g.stroke();
    }
    g.restore();
    // a half-built contraption on the left: a wheel on a frame with gears
    g.save();
    g.translate(-112, 28);
    g.fillStyle = "rgba(44,46,24,.22)";
    g.beginPath();
    g.ellipse(6, 2, 32, 7, 0, 0, 7);
    g.fill();
    g.strokeStyle = "#5e4b36";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(-24, 0);
    g.lineTo(-10, -44);
    g.lineTo(6, 0);
    g.moveTo(-17, -22);
    g.lineTo(22, -22);
    g.lineTo(26, 0);
    g.stroke();
    g.strokeStyle = "#7b6549";
    g.lineWidth = 2.4;
    g.beginPath();
    g.arc(-10, -44, 16, 0, 7);
    g.stroke();
    g.lineWidth = 1;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 6.28;
      g.beginPath();
      g.moveTo(-10, -44);
      g.lineTo(-10 + Math.cos(a) * 16, -44 + Math.sin(a) * 16);
      g.stroke();
    }
    g.beginPath();
    g.arc(-10, -44, 17.5, 0, 7);
    ink(g, 0.8, 0.7);
    gear(g, 12, -28, 8, 9);
    gear(g, 22, -18, 5, 7);
    g.restore();
    // lanterns along the eave
    lantern(g, -58, -66, s.night);
    lantern(g, 70, -70, s.night);
    crate(g, -150, 44, 14);
    rocks(g, 150, 46, r, 2);
    grain(g, GRAIN_BOX, parkMiller(793));
  },
  animate(g, s) {
    if (s.open) openDoor(g, 0, 0, 24, 42, false);
  },
};
