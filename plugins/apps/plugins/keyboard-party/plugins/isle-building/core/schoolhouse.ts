// Keyboard Party's building on Isle: the village schoolhouse where letters are
// learnt — a gabled stone school with a bell cote, shutters in the app's
// colour, alphabet blocks on the step, and a slate on its easel where chalk
// writes Aa, Bb… through the alphabet, a letter at a time.

import {
  poly,
  polyKit,
  type BuildingSpec,
  type Ctx2D,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const {
  INK,
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

const GRAIN_BOX = [-160, -230, 160, 55] as const;
const OLD_STONE = ["#8d8676", "#c9c1ad", "#7c8a5a"] as const;
/** The slate on its easel: centre and size. */
const SB = { x: 70, y: -56, w: 40, h: 30 } as const;

/** A worn alphabet block of side `sz` standing at (x, y), tilted by `a`. */
function block(
  g: Ctx2D,
  x: number,
  y: number,
  sz: number,
  ch: string,
  tint: string,
  a: number,
): void {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.fillStyle = tint;
  g.fillRect(-sz / 2, -sz, sz, sz);
  g.fillStyle = mix(tint, "#3a2e22", 0.3);
  g.beginPath();
  g.moveTo(sz / 2, 0);
  g.lineTo(sz / 2 + 4, -3);
  g.lineTo(sz / 2 + 4, -sz - 3);
  g.lineTo(sz / 2, -sz);
  g.fill();
  g.fillStyle = mix(tint, "#fff8e6", 0.3);
  g.beginPath();
  g.moveTo(-sz / 2, -sz);
  g.lineTo(sz / 2, -sz);
  g.lineTo(sz / 2 + 4, -sz - 3);
  g.lineTo(-sz / 2 + 4, -sz - 3);
  g.fill();
  g.beginPath();
  g.rect(-sz / 2, -sz, sz, sz);
  ink(g, 0.9, 0.8);
  g.fillStyle = "rgba(50,38,26,.75)";
  g.font = `700 ${sz * 0.72}px Georgia, serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(ch, 0, -sz / 2 + 0.5);
  g.restore();
}

export const schoolhouse: BuildingSpec = {
  footprint: {
    w: 176,
    depth: 74,
    ground: [-115, -112, 151, 44],
    upper: [-77, -172, 93, -112],
  },
  setting: ["lane", "square"],
  signX: -130,
  lights: [
    [0, -34, 20],
    [-46, -50, 16],
    [46, -50, 16],
  ],
  paint(g, s) {
    const r = s.rnd;
    const acc = accent(s.hue, 0.3);
    castShadow(g, [
      [-70, 2],
      [130, 8],
      [150, -40],
      [80, -110],
      [-30, -60],
    ]);
    const W = 130;
    const h = 70;
    const sd = 18;
    const L = -W / 2;
    const R = W / 2;
    // the gable end facing us: stone lower walls, timber gable, slate roof running back
    const front: Pt[] = [
      [L, 0],
      [R, 0],
      [R, -h],
      [0, -h - 52],
      [L, -h],
    ];
    const wall: Pt[] = [
      [L, 0],
      [R, 0],
      [R, -h],
      [L, -h],
    ];
    stones(g, wall, r);
    wash(g, wall, "rgba(0,0,0,0)", OLD_STONE, r, 18, 12);
    const gab: Pt[] = [
      [L + 4, -h],
      [R - 4, -h],
      [0, -h - 48],
    ];
    boards(g, gab, r, ["#8a7254", "#7b6549", "#9c845f"], 8);
    g.fillStyle = "rgba(30,24,16,.12)";
    poly(g, gab);
    g.fill();
    const side: Pt[] = [
      [R, 0],
      [R + sd, -12],
      [R + sd, -h - 12],
      [R, -h],
    ];
    stones(g, side, r);
    g.fillStyle = "rgba(30,26,20,.35)";
    poly(g, side);
    g.fill();
    hatch(g, side, r, 3.5, 0.18);
    poly(g, side);
    ink(g, 1.2);
    // the right roof slope seen from above, running back
    shingles(
      g,
      [
        [R + 6, -h + 4],
        [0, -h - 56],
        [sd + 2, -h - 56 - 40],
        [R + sd + 8, -h - 40 + 4],
      ],
      r,
      SLATE,
      6,
      9,
    );
    poly(g, front);
    ink(g, 1.4);
    // barge boards
    g.strokeStyle = "#4e3e2c";
    g.lineWidth = 5;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(L - 8, -h + 6);
    g.lineTo(0, -h - 58);
    g.lineTo(R + 8, -h + 6);
    g.stroke();
    g.strokeStyle = INK;
    g.lineWidth = 0.9;
    g.stroke();
    // a bell cote on the ridge
    g.save();
    g.translate(sd * 0.55 + 4, -h - 62);
    const bc: Pt[] = [
      [-10, 0],
      [10, 0],
      [10, -24],
      [-10, -24],
    ];
    boards(g, bc, r, ["#7b6549", "#6e5a42"], 5);
    poly(g, bc);
    ink(g, 1);
    g.fillStyle = "#1e1a16";
    g.beginPath();
    g.moveTo(-6, -2);
    g.lineTo(-6, -14);
    g.arc(0, -14, 6, Math.PI, 0);
    g.lineTo(6, -2);
    g.closePath();
    g.fill();
    g.fillStyle = "#b08a3c";
    g.beginPath();
    g.moveTo(-3, -12);
    g.quadraticCurveTo(-4, -6, -5, -4);
    g.lineTo(5, -4);
    g.quadraticCurveTo(4, -6, 3, -12);
    g.closePath();
    g.fill();
    shingles(
      g,
      [
        [-15, -22],
        [15, -22],
        [0, -38],
      ],
      r,
      SLATE,
      5,
      6,
    );
    g.restore();
    // a round window in the gable, tall windows with accent shutters
    g.fillStyle = "#5c4a36";
    g.beginPath();
    g.arc(0, -h - 20, 10, 0, 7);
    g.fill();
    g.fillStyle = s.night ? "#ffd27a" : "#3d4a52";
    g.beginPath();
    g.arc(0, -h - 20, 7.5, 0, 7);
    g.fill();
    g.strokeStyle = "#4a3a2a";
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-7.5, -h - 20);
    g.lineTo(7.5, -h - 20);
    g.moveTo(0, -h - 27.5);
    g.lineTo(0, -h - 12.5);
    g.stroke();
    g.beginPath();
    g.arc(0, -h - 20, 10, 0, 7);
    ink(g, 1);
    windowAt(g, -50, -54, 16, 26, s, { shutter: acc });
    windowAt(g, 34, -54, 16, 26, s, { shutter: acc });
    // stone steps and the door painted in the app colour
    g.fillStyle = "#a9a397";
    g.fillRect(-20, 0, 40, 5);
    g.fillRect(-16, 5, 32, 4);
    g.beginPath();
    g.rect(-20, 0, 40, 5);
    g.rect(-16, 5, 32, 4);
    ink(g, 0.8, 0.6);
    plankDoor(g, 0, 0, 24, 42, acc, r);
    // a small carved lintel plaque
    g.fillStyle = "#cbc4b2";
    g.fillRect(-14, -58, 28, 7);
    g.beginPath();
    g.rect(-14, -58, 28, 7);
    ink(g, 0.8, 0.7);
    moss(g, L, R, 0, r);
    ivy(g, L + 4, -2, 56, r);
    tufts(g, -110, 120, 2, r, 22);
    ao(g, L, R + sd, 2);
    // the slate on its easel (the chalk is animated), worn alphabet blocks on the step
    g.save();
    g.translate(SB.x, 0);
    g.fillStyle = "rgba(44,46,24,.24)";
    g.beginPath();
    g.ellipse(10, 6, 26, 5, 0, 0, 7);
    g.fill();
    g.strokeStyle = "#5e4b36";
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(-16, 6);
    g.lineTo(-6, -60);
    g.moveTo(18, 6);
    g.lineTo(8, -60);
    g.moveTo(10, 8);
    g.lineTo(2, -40);
    g.stroke();
    g.restore();
    g.fillStyle = "#6e5a42";
    g.fillRect(SB.x - SB.w / 2 - 3, SB.y - SB.h / 2 - 3, SB.w + 6, SB.h + 6);
    g.beginPath();
    g.rect(SB.x - SB.w / 2 - 3, SB.y - SB.h / 2 - 3, SB.w + 6, SB.h + 6);
    ink(g, 1);
    g.fillStyle = "#33393b";
    g.fillRect(SB.x - SB.w / 2, SB.y - SB.h / 2, SB.w, SB.h);
    wash(
      g,
      [
        [SB.x - SB.w / 2, SB.y - SB.h / 2],
        [SB.x + SB.w / 2, SB.y - SB.h / 2],
        [SB.x + SB.w / 2, SB.y + SB.h / 2],
        [SB.x - SB.w / 2, SB.y + SB.h / 2],
      ],
      "rgba(0,0,0,0)",
      ["#4a5052", "#2a2f31", "#5a6062"],
      r,
      14,
      6,
    );
    g.fillStyle = "#5e4b36";
    g.fillRect(SB.x - SB.w / 2 - 3, SB.y + SB.h / 2 + 2, SB.w + 6, 3);
    g.fillStyle = "#efe9dc";
    g.fillRect(SB.x + 6, SB.y + SB.h / 2, 7, 2);
    block(g, -40, 20, 12, "A", "#c9b48a", -0.06);
    block(g, -27, 21, 12, "B", mix(acc, "#c9b48a", 0.5), 0.05);
    block(g, -34, 9, 11, "C", "#b8a27a", 0.1);
    rocks(g, 120, 40, r, 2);
    barrel(g, -78, 30);
    grain(g, GRAIN_BOX, parkMiller(662));
  },
  animate(g, s) {
    // chalk: write the letter, hold, wipe, next — slowly through the alphabet
    const P = 4.2;
    const k = Math.floor(s.t / P) % 26;
    const ph = (s.t % P) / P;
    const upper = String.fromCharCode(65 + k);
    const alpha = ph < 0.15 ? ph / 0.15 : ph > 0.85 ? (1 - ph) / 0.15 : 1;
    g.save();
    g.beginPath();
    g.rect(SB.x - SB.w / 2, SB.y - SB.h / 2, SB.w, SB.h);
    g.clip();
    g.globalAlpha = 0.9 * alpha;
    g.fillStyle = "#efe9dc";
    g.font = "600 19px Georgia, serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(upper + upper.toLowerCase(), SB.x, SB.y + 1);
    if (ph > 0.85) {
      g.globalAlpha = 0.5;
      g.fillStyle = "#5a5f61";
      g.fillRect(
        SB.x - SB.w / 2 + ((ph - 0.85) / 0.15) * SB.w - 8,
        SB.y - SB.h / 2,
        10,
        SB.h,
      );
    }
    g.restore();
    g.globalAlpha = 1;
    if (s.open) openDoor(g, 0, 0, 24, 42);
  },
};
