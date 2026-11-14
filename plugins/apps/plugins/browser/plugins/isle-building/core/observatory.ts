// The Browser's building on Isle: the observatory — a round stone tower under
// a verdigris copper dome whose slot and brass telescope turn slowly, a globe
// and a telescope on a tripod out front.

import {
  accent,
  castShadow,
  doorArch,
  grain,
  hline,
  ink,
  jit,
  moss,
  shrub,
  spill,
  steps,
  stones,
  tufts,
  wash,
  windowRect,
  type Box,
  type BuildingSpec,
  type Ctx2D,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";

const GRAIN_BOX: Box = [-150, -300, 170, 40];
const R = 70;
const YT = -128;

/** The dome's outline (its upper half-ellipse closed by the cornice's lower half). */
function domePath(g: Ctx2D): void {
  g.beginPath();
  g.ellipse(0, YT - 2, R + 1, 74, 0, Math.PI, 0);
  g.ellipse(0, YT - 2, R + 1, 17, 0, 0, Math.PI);
  g.closePath();
}

export const observatory: BuildingSpec = {
  footprint: {
    w: 184,
    depth: 104,
    ground: [-112, -112, 152, 45],
    upper: [-77, -238, 85, -112],
  },
  setting: ["hill"],
  signX: 128,
  lights: [
    [-36, -60, 10],
    [36, -60, 10],
    [0, -24, 12],
    [0, -150, 20],
  ],
  paint(g, s) {
    const r = s.rnd;
    const A = accent(s.hue);
    const yb = -6;
    const yt = YT;
    castShadow(
      g,
      [
        [-R + 6, 4],
        [R, 4],
        [R + 74, 26],
        [R + 40, -40],
        [R - 10, -80],
      ],
      0.3,
    );
    // a low dry-stone wall curving round the back
    stones(g, -R - 34, -34, -R + 6, -8, r, {
      rowH: 8,
      blockW: 14,
      base: "#a39b89",
    });
    stones(g, R - 6, -34, R + 30, -8, r, {
      rowH: 8,
      blockW: 14,
      base: "#9a927f",
    });
    // the round tower: curved courses, lit from the left
    const body = () => {
      g.beginPath();
      g.moveTo(-R, yb);
      g.lineTo(-R, yt);
      g.ellipse(0, yt, R, 18, 0, Math.PI, 0, true);
      g.lineTo(R, yb);
      g.ellipse(0, yb, R, 18, 0, 0, Math.PI);
      g.closePath();
    };
    g.save();
    body();
    g.clip();
    const gr = g.createLinearGradient(-R, 0, R, 0);
    gr.addColorStop(0, "#cfc8b7");
    gr.addColorStop(0.4, "#b8b09e");
    gr.addColorStop(1, "#77705f");
    g.fillStyle = gr;
    g.fillRect(-R, yt - 20, 2 * R, yb - yt + 40);
    for (let y = yb + 12; y > yt; y -= 11) {
      ink(g, 0.7, 0.38);
      g.beginPath();
      g.ellipse(0, y, R, 18, 0, 0.05, Math.PI - 0.05);
      g.stroke();
      for (
        let a = Math.round(y / 11) % 2 ? 0.2 : 0.02;
        a < Math.PI;
        a += 0.32
      ) {
        const x = -Math.cos(a) * R;
        const yy = y + Math.sin(a) * 18;
        hline(g, x, yy, x, yy - 11, r, 0.2);
      }
      for (let k = 0; k < 8; k++) {
        g.fillStyle = jit("#b4ad9c", r, 40, 0.22);
        g.beginPath();
        g.ellipse(-R + r() * 2 * R, y + 6, 5 + r() * 4, 3, 0, 0, 7);
        g.fill();
      }
    }
    g.restore();
    body();
    ink(g, 1.5);
    g.stroke();
    // a cornice ring, then the copper dome (the slot and telescope are animated)
    g.fillStyle = "#a9a18f";
    g.beginPath();
    g.ellipse(0, yt, R + 5, 20, 0, 0, 7);
    g.fill();
    ink(g, 1.3);
    g.stroke();
    wash(g, () => domePath(g), [-R, yt - 76, R, yt + 16], "#6e9686", r, {
      blob: 8,
      var: 34,
      shadeA: 0.4,
      hatch: 30,
    });
    // copper showing through the verdigris, and seams
    for (let k = 0; k < 14; k++) {
      g.fillStyle = `rgba(150,96,58,${0.18 + r() * 0.2})`;
      g.beginPath();
      g.ellipse(
        -R + 10 + r() * (2 * R - 20),
        yt - 10 - r() * 50,
        4 + r() * 7,
        2 + r() * 3,
        r() * 3,
        0,
        7,
      );
      g.fill();
    }
    ink(g, 0.7, 0.45);
    for (let k = -3; k <= 3; k++) {
      if (!k) continue;
      g.beginPath();
      g.ellipse(
        0,
        yt - 2,
        (Math.abs(k) * R) / 4,
        74,
        0,
        Math.PI + (k > 0 ? Math.PI / 2 : 0),
        Math.PI + (k > 0 ? Math.PI : Math.PI / 2),
      );
      g.stroke();
    }
    g.fillStyle = "#8a6a3e";
    g.beginPath();
    g.arc(0, yt - 78, 4, 0, 7);
    g.fill();
    ink(g, 1);
    g.stroke();
    // windows, door, steps
    windowRect(g, -44, -50, 14, 26, r, { arch: true, lit: s.night });
    windowRect(g, 30, -50, 14, 26, r, { arch: true, lit: s.night });
    doorArch(g, 0, 8, 26, 42, r, { col: A });
    steps(g, 0, 12, 30, 2, r);
    // star-chart plaque over the door
    g.fillStyle = "#3e4a52";
    g.beginPath();
    g.arc(0, -46, 8, 0, 7);
    g.fill();
    ink(g, 1);
    g.stroke();
    g.fillStyle = "#e9dca6";
    for (const [x, y] of [
      [-3, -48],
      [2, -50],
      [4, -44],
      [-2, -43],
    ] as const)
      g.fillRect(x, y, 1.4, 1.4);
    // the globe on its stand, and a brass telescope on a tripod
    const gx = -58;
    const gy = 32;
    castShadow(
      g,
      [
        [gx - 10, gy],
        [gx + 10, gy],
        [gx + 18, gy + 5],
        [gx, gy + 5],
      ],
      0.3,
    );
    g.strokeStyle = "#5a4632";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(gx - 8, gy);
    g.lineTo(gx, gy - 12);
    g.lineTo(gx + 8, gy);
    g.moveTo(gx, gy - 12);
    g.lineTo(gx, gy - 16);
    g.stroke();
    wash(
      g,
      () => {
        g.beginPath();
        g.arc(gx, gy - 26, 10, 0, 7);
      },
      [gx - 10, gy - 36, gx + 10, gy - 16],
      "#8fa9a2",
      r,
      { blob: 3, var: 24, shadeA: 0.35 },
    );
    g.fillStyle = "rgba(170,150,100,.55)";
    g.beginPath();
    g.ellipse(gx - 3, gy - 28, 4, 3, 0.3, 0, 7);
    g.ellipse(gx + 4, gy - 22, 3, 2, 0, 0, 7);
    g.fill();
    g.strokeStyle = "#a8874f";
    g.lineWidth = 1.8;
    g.beginPath();
    g.arc(gx, gy - 26, 12, -2.2, 1.2);
    g.stroke();
    const tx = 58;
    const ty = 30;
    g.strokeStyle = "#4a3c2e";
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(tx - 8, ty);
    g.lineTo(tx, ty - 22);
    g.lineTo(tx + 8, ty);
    g.moveTo(tx, ty - 22);
    g.lineTo(tx + 1, ty + 2);
    g.stroke();
    g.save();
    g.translate(tx, ty - 24);
    g.rotate(-0.55);
    wash(
      g,
      () => {
        g.beginPath();
        g.rect(-10, -3, 26, 6);
      },
      [-10, -3, 16, 3],
      "#b08d57",
      r,
      { blob: 2, var: 30, lw: 1 },
    );
    g.fillStyle = "#3e3a35";
    g.fillRect(14, -3.5, 3, 7);
    g.restore();
    moss(g, -R, R, 4, r, 12);
    tufts(g, -R - 20, R + 10, 8, r, 22);
    for (const [x, y, z, k] of [
      [-96, 14, 15, 0],
      [88, 6, 12, 1],
      [112, 20, 9, 2],
    ] as const)
      shrub(g, x, y, z, r, k);
    grain(g, GRAIN_BOX, r);
  },
  animate(g, s) {
    // the slot turns with the telescope; the dome is painted under it
    const a = Math.sin(s.t * 0.12) * 0.9; // -0.9..0.9 rad around the dome
    g.save();
    domePath(g);
    g.clip();
    const x = Math.sin(a) * R * 0.8;
    const w = 12 * Math.cos(a) + 3;
    g.fillStyle = "#1c1916";
    g.beginPath();
    g.moveTo(x - w / 2, YT + 6);
    g.quadraticCurveTo(x * 0.5 - w / 2, YT - 50, x * 0.2 - w / 3, YT - 74);
    g.lineTo(x * 0.2 + w / 3, YT - 74);
    g.quadraticCurveTo(x * 0.5 + w / 2, YT - 50, x + w / 2, YT + 6);
    g.closePath();
    g.fill();
    g.strokeStyle = "rgba(48,38,28,.85)";
    g.lineWidth = 1.2;
    g.stroke();
    g.restore();
    // the brass telescope poking out of the slot
    g.save();
    g.translate(x * 0.55, YT - 44);
    g.rotate(-1.05 + a * 0.6);
    const tube = g.createLinearGradient(0, -6, 0, 6);
    tube.addColorStop(0, "#d8b878");
    tube.addColorStop(0.5, "#a8874f");
    tube.addColorStop(1, "#6e5530");
    g.fillStyle = tube;
    g.beginPath();
    g.moveTo(-4, -5);
    g.lineTo(60, -7);
    g.lineTo(60, 7);
    g.lineTo(-4, 5);
    g.closePath();
    g.fill();
    ink(g, 1.2);
    g.stroke();
    g.fillStyle = "#6e5530";
    for (const k of [10, 30, 50]) g.fillRect(k, -6.5, 2.5, 13);
    g.fillStyle = "#2a2622";
    g.fillRect(58, -8, 5, 16);
    ink(g, 1);
    g.strokeRect(58, -8, 5, 16);
    g.restore();
    if (s.open) spill(g, 26, 0.45);
  },
};
