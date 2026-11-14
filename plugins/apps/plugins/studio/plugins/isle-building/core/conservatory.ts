// Studio's building on Isle: the inspector's conservatory laboratory — a stone
// cottage beside an iron-framed glasshouse full of plants and jars, a glazed
// porch with a magnifier sign, a brass magnifier on a tripod out front, and a
// puzzle-piece weathervane turning on the cottage ridge.

import {
  poly,
  polyKit,
  type BuildingSpec,
  type Pt,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const {
  INK,
  SLATE,
  accent,
  ao,
  castShadow,
  crate,
  grain,
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

const GRAIN_BOX = [-170, -200, 175, 55] as const;
const OLD_STONE = ["#8d8676", "#c9c1ad", "#7c8a5a"] as const;
const LEAVES = ["#4f5d33", "#6b7a42", "#5c6a38"] as const;

export const conservatory: BuildingSpec = {
  footprint: {
    w: 230,
    depth: 78,
    ground: [-141, -112, 176, 45],
    upper: [-122, -173, 134, -112],
  },
  setting: ["forest"],
  signX: -150,
  lights: [
    [-62, -40, 18],
    [62, -50, 40],
    [0, -30, 20],
  ],
  paint(g, s) {
    const r = s.rnd;
    const acc = accent(s.hue, 0.2);
    castShadow(g, [
      [-110, 2],
      [150, 8],
      [175, -30],
      [130, -70],
      [-40, -40],
    ]);
    // the stone cottage on the left
    g.save();
    g.translate(-62, 0);
    const front: Pt[] = [
      [-50, 0],
      [44, 0],
      [44, -78],
      [-50, -78],
    ];
    stones(g, front, r);
    wash(g, front, "rgba(0,0,0,0)", OLD_STONE, r, 18, 12);
    poly(g, front);
    ink(g, 1.3);
    shingles(
      g,
      [
        [-58, -72],
        [52, -72],
        [60, -138],
        [-48, -138],
      ],
      r,
      SLATE,
      7,
      10,
    );
    g.fillStyle = "rgba(30,24,16,.3)";
    g.fillRect(-50, -78, 94, 8);
    g.strokeStyle = "rgba(40,32,22,.8)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-48, -138);
    g.lineTo(60, -138);
    g.stroke();
    const ch: Pt[] = [
      [-30, -126],
      [-16, -126],
      [-16, -156],
      [-30, -156],
    ];
    stones(g, ch, r);
    poly(g, ch);
    ink(g, 1);
    g.fillStyle = "#3a332c";
    g.fillRect(-32, -160, 18, 5);
    windowAt(g, -38, -56, 18, 20, s, { shutter: mix(acc, "#5e4b36", 0.35) });
    ivy(g, -46, -2, 70, r);
    moss(g, -50, 44, 0, r);
    g.restore();
    // the conservatory on the right: brick dwarf wall, iron-framed glass, a lantern roof
    g.save();
    g.translate(64, 0);
    const dwarf: Pt[] = [
      [-46, 0],
      [56, 0],
      [56, -16],
      [-46, -16],
    ];
    stones(g, dwarf, r, ["#a07a62", "#8e6a54", "#b08a70", "#946e58"], 6);
    poly(g, dwarf);
    ink(g, 1.1);
    const glass: Pt[] = [
      [-44, -16],
      [54, -16],
      [54, -86],
      [-44, -86],
    ];
    poly(g, glass);
    const gg = g.createLinearGradient(-44, -86, 54, -16);
    gg.addColorStop(0, s.night ? "#f3c27a" : "#9fb7b8");
    gg.addColorStop(1, s.night ? "#c98a48" : "#5d7476");
    g.fillStyle = gg;
    g.fill();
    // inside: plants, jars on a workbench
    g.save();
    poly(g, glass);
    g.clip();
    for (let k = 0; k < 9; k++) {
      const px = -38 + k * 11 + r() * 4;
      g.fillStyle = LEAVES[k % 3]!;
      g.globalAlpha = 0.75;
      g.beginPath();
      g.ellipse(px, -40 - r() * 26, 7 + r() * 5, 10 + r() * 8, 0, 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = "#5e4b36";
    g.fillRect(-44, -34, 98, 4);
    const jars = [
      "rgba(160,190,170,.8)",
      "rgba(200,170,110,.8)",
      mix(acc, "#c0d0c8", 0.5),
    ];
    for (let k = 0; k < 6; k++) {
      const jx = -36 + k * 15;
      g.fillStyle = jars[k % 3]!;
      g.fillRect(jx, -44, 7, 10);
      g.strokeStyle = "rgba(48,38,28,.6)";
      g.lineWidth = 0.7;
      g.strokeRect(jx, -44, 7, 10);
      g.fillStyle = "#5e4b36";
      g.fillRect(jx - 0.5, -46, 8, 2);
    }
    g.fillStyle = "rgba(255,255,255,.18)";
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.moveTo(-40 + k * 22, -86);
      g.lineTo(-30 + k * 22, -86);
      g.lineTo(-48 + k * 22, -16);
      g.lineTo(-56 + k * 22, -16);
      g.fill();
    }
    g.restore();
    g.strokeStyle = "#2e3336";
    g.lineWidth = 2;
    for (let x = -44; x <= 54; x += 14) {
      g.beginPath();
      g.moveTo(x, -16);
      g.lineTo(x, -86);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-44, -52);
    g.lineTo(54, -52);
    g.stroke();
    g.lineWidth = 1;
    for (let x = -44; x < 54; x += 14) {
      g.beginPath();
      g.arc(x + 7, -78, 6, Math.PI, 0);
      g.stroke();
    }
    poly(g, glass);
    ink(g, 1.4);
    // the glass roof seen from above
    const roof: Pt[] = [
      [-50, -84],
      [60, -84],
      [68, -130],
      [-42, -130],
    ];
    poly(g, roof);
    const rg = g.createLinearGradient(0, -130, 0, -84);
    rg.addColorStop(0, s.night ? "#d39a58" : "#b9cccc");
    rg.addColorStop(1, s.night ? "#a8723c" : "#7f9698");
    g.fillStyle = rg;
    g.fill();
    g.strokeStyle = "#2e3336";
    g.lineWidth = 1.6;
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      g.beginPath();
      g.moveTo(-50 + 110 * t, -84);
      g.lineTo(-42 + 110 * t, -130);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-46, -107);
    g.lineTo(64, -107);
    g.stroke();
    poly(g, roof);
    ink(g, 1.3);
    g.fillStyle = "#3a3633";
    g.fillRect(-42, -134, 110, 4);
    g.restore();
    // the glazed porch in the middle with the door
    const porch: Pt[] = [
      [-22, 0],
      [22, 0],
      [22, -62],
      [-22, -62],
    ];
    poly(g, porch);
    g.fillStyle = "#b9b2a3";
    g.fill();
    stones(g, porch, r);
    poly(g, porch);
    ink(g, 1.2);
    const gable: Pt[] = [
      [-28, -58],
      [28, -58],
      [0, -86],
    ];
    poly(g, gable);
    g.fillStyle = "#5e636b";
    g.fill();
    shingles(g, gable, r, SLATE, 5, 7);
    g.fillStyle = mix(acc, "#efe4c8", 0.2);
    g.beginPath();
    g.arc(0, -66, 6, 0, 7);
    g.fill();
    ink(g, 0.9);
    g.strokeStyle = "#2e3336";
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(-1, -67, 2.6, 0, 7);
    g.moveTo(1, -65);
    g.lineTo(3.5, -62.5);
    g.stroke();
    plankDoor(g, 0, 0, 22, 40, acc, r);
    tufts(g, -120, 130, 2, r, 26);
    ao(g, -112, 120, 2);
    // the brass magnifier on its tripod, out front
    g.save();
    g.translate(-128, 30);
    g.fillStyle = "rgba(44,46,24,.25)";
    g.beginPath();
    g.ellipse(10, 0, 18, 5, 0, 0, 7);
    g.fill();
    g.strokeStyle = "#5e4b36";
    g.lineWidth = 2.2;
    for (const [fx, fy] of [
      [-10, 0],
      [10, 0],
      [2, 4],
    ] as const) {
      g.beginPath();
      g.moveTo(fx, fy);
      g.lineTo(0, -34);
      g.stroke();
    }
    g.strokeStyle = "#9a7a3a";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, -34);
    g.lineTo(4, -48);
    g.stroke();
    const lg = g.createRadialGradient(4, -64, 2, 6, -62, 16);
    lg.addColorStop(0, "rgba(230,245,245,.85)");
    lg.addColorStop(1, "rgba(140,170,170,.75)");
    g.fillStyle = lg;
    g.beginPath();
    g.ellipse(6, -62, 13, 15, 0.2, 0, 7);
    g.fill();
    g.strokeStyle = "#b08a3c";
    g.lineWidth = 3.4;
    g.stroke();
    g.strokeStyle = INK;
    g.lineWidth = 0.9;
    g.beginPath();
    g.ellipse(6, -62, 15, 17, 0.2, 0, 7);
    g.stroke();
    g.fillStyle = "rgba(255,255,255,.6)";
    g.beginPath();
    g.ellipse(2, -67, 3, 5, 0.4, 0, 7);
    g.fill();
    g.restore();
    crate(g, 118, 34, 16);
    crate(g, 136, 30, 13);
    rocks(g, 150, 44, r, 2);
    grain(g, GRAIN_BOX, parkMiller(793));
  },
  animate(g, s) {
    // a puzzle-piece weathervane turning on the cottage ridge
    g.save();
    g.translate(-30, -140);
    g.strokeStyle = "#2e2a26";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -24);
    g.stroke();
    g.scale(Math.cos(s.t * 0.5), 1);
    g.fillStyle = "#3a3633";
    g.fillRect(-10, -26, 14, 8);
    g.beginPath();
    g.arc(6, -22, 3, 0, 7);
    g.arc(-3, -28, 3, 0, 7);
    g.fill();
    g.beginPath();
    g.moveTo(4, -22);
    g.lineTo(16, -22);
    g.stroke();
    g.restore();
    if (s.open) openDoor(g, 0, 0, 22, 40);
  },
};
